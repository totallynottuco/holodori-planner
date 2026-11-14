/** GPU player for the baked Cubism deformation samples and source texture atlases. */
import waistAnchors from './outfit-waist-anchors.json';

const assets = '/assets/outfits/';
// Lower-midriff landmarks in exported mesh units below the rig's head anchor.
// Keep the landmarks fixed while the idle and reaction poses move.
const headMargin = .105;
const defaultWaist = .82;

function outfitDecoder(signal, directory) {
  const worker = new Worker('/app/outfit-decode-worker.js', {type:'module'});
  let pending;
  worker.onmessage = ({data}) => {
    const current = pending;
    pending = null;
    if (data.error) current?.reject(Error(data.error));
    else current?.resolve(data.clip);
  };
  worker.onerror = () => pending?.reject(Error('Outfit decoder unavailable'));
  signal.addEventListener('abort', () => {
    worker.terminate();
    pending?.reject(signal.reason);
    pending = null;
  }, {once:true});
  return (asset, slot, model) => new Promise((resolve,reject) => {
    pending = {resolve,reject};
    worker.postMessage({asset,slot,directory,geometry:model && {
      vertexValues:model.coordinates.length,meshCount:model.meshes.length,
    }});
  });
}
const vertexSource = `#version 300 es
in vec2 position;
in vec2 nextPosition;
in vec2 uv;
uniform vec2 viewScale;
uniform float viewTop;
uniform float fraction;
out vec2 texCoord;
void main() {
  vec2 point = mix(position, nextPosition, fraction);
  gl_Position = vec4(point.x * viewScale.x, viewTop - (point.y - 0.13) * viewScale.y, 0, 1);
  texCoord = uv;
}`;
const fragmentSource = `#version 300 es
precision highp float;
in vec2 texCoord;
uniform sampler2D atlas;
uniform sampler2D mask;
uniform vec2 resolution;
uniform vec3 multiplyColor;
uniform vec3 screenColor;
uniform float opacity;
uniform int clipMode;
out vec4 color;
void main() {
  vec4 pixel = texture(atlas, texCoord);
  float a = pixel.a * opacity;
  if (clipMode != 0) {
    float coverage = texture(mask, gl_FragCoord.xy / resolution).a;
    a *= clipMode == 1 ? coverage : 1.0 - coverage;
  }
  vec3 rgb = pixel.rgb * multiplyColor;
  rgb += screenColor * (1.0 - rgb);
  color = vec4(rgb * a, a);
}`;

function makeRenderer(canvas, model, bitmaps, asset) {
  const gl = canvas.getContext('webgl2', {alpha:true, premultipliedAlpha:true, depth:false, stencil:false});
  if (!gl) throw new Error('WebGL2 unavailable');
  const dispose = [];
  const keep = (handle, remove) => {
    if (!handle) throw new Error('Unable to allocate outfit graphics');
    dispose.push(() => remove.call(gl, handle));
    return handle;
  };
  try {
    const program = keep(gl.createProgram(), gl.deleteProgram);
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = keep(gl.createShader(type), gl.deleteShader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const uniform = Object.fromEntries(['viewScale','viewTop','fraction','atlas','mask','resolution','multiplyColor',
      'screenColor','opacity','clipMode'].map(name => [name, gl.getUniformLocation(program, name)]));
    const bindBuffer = (target, data, usage) => {
      const buffer = keep(gl.createBuffer(), gl.deleteBuffer);
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, usage);
      return buffer;
    };
    const vao = keep(gl.createVertexArray(), gl.deleteVertexArray);
    gl.bindVertexArray(vao);
    bindBuffer(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);
    const attribute = (name, data, usage) => {
      const location = gl.getAttribLocation(program, name);
      const buffer = bindBuffer(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      return buffer;
    };
    attribute('uv', model.coordinates, gl.STATIC_DRAW);
    const position = attribute('position', model.coordinates.byteLength, gl.DYNAMIC_DRAW);
    const nextPosition = attribute('nextPosition', model.coordinates.byteLength, gl.DYNAMIC_DRAW);
    const texture = () => {
      const tex = keep(gl.createTexture(), gl.deleteTexture);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    const atlases = bitmaps.map(bitmap => {
      const tex = texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      return tex;
    });
    const framebuffer = keep(gl.createFramebuffer(), gl.deleteFramebuffer);
    const maskGroups = new Map();
    const meshes = model.meshes.map(([start, count, atlas, clips, flags]) => {
      const key = clips.length ? clips.join(',') : '';
      if (key) maskGroups.set(key, clips);
      return {offset:start * 4, count, atlas, key, flags};
    });
    const masks = new Map([...maskGroups.keys()].map(key => [key, texture()]));
    gl.uniform1i(uniform.atlas, 0);
    gl.uniform1i(uniform.mask, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    let width = 0;
    let height = 0;
    let boundAtlas = -1;
    let blendMode = -1;
    const blend = mode => {
      if (blendMode === mode) return;
      blendMode = mode;
      if (mode === 1) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else if (mode === 2) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    const paint = (index, colors, maskPass) => {
      const mesh = meshes[index];
      const offset = index * 7;
      const opacity = maskPass ? 1 : colors[offset];
      if (opacity <= .001 || !mesh.count) return;
      if (boundAtlas !== mesh.atlas) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, atlases[mesh.atlas]);
        boundAtlas = mesh.atlas;
      }
      blend(maskPass ? 0 : mesh.flags & 3);
      gl.uniform1f(uniform.opacity, opacity);
      gl.uniform3fv(uniform.multiplyColor, colors, offset + 1, 3);
      gl.uniform3fv(uniform.screenColor, colors, offset + 4, 3);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, mesh.offset);
    };
    let currentPoints, followingPoints;
    return {
      dispose() { for (const free of dispose.reverse()) free(); },
      draw(time, reaction) {
        const ratio = Math.min(window.devicePixelRatio || 1, 3);
        const w = Math.round(canvas.clientWidth * ratio);
        const h = Math.round(canvas.clientHeight * ratio);
        if (!w || !h || gl.isContextLost()) return;
        if (width !== w || height !== h) {
          width = canvas.width = w;
          height = canvas.height = h;
          gl.viewport(0, 0, w, h);
          gl.uniform2f(uniform.resolution, w, h);
          const scale = (1 - headMargin) / (waistAnchors[asset] ?? defaultWaist);
          gl.uniform2f(uniform.viewScale, 2 * h / w * scale, 2 * scale);
          gl.uniform1f(uniform.viewTop, 1 - 2 * headMargin);
          gl.activeTexture(gl.TEXTURE1);
          const maskWidth = Math.ceil(w / 2), maskHeight = Math.ceil(h / 2);
          for (const mask of masks.values()) {
            gl.bindTexture(gl.TEXTURE_2D, mask);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          }
          boundAtlas = -1;
        }
        const clip = reaction ?? model;
        const frame = reaction
          ? Math.min(time / clip.duration * clip.frames.length, clip.frames.length - 1)
          : time / model.duration % 1 * model.frameCount;
        const index = Math.floor(frame);
        const {points, order, colors} = clip.frames[index];
        const next = clip.frames[(index + 1) % clip.frames.length].points;
        if (currentPoints !== points || followingPoints !== next) {
          currentPoints = points;
          followingPoints = next;
          gl.bindBuffer(gl.ARRAY_BUFFER, position);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, points);
          gl.bindBuffer(gl.ARRAY_BUFFER, nextPosition);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, next);
        }
        gl.uniform1f(uniform.fraction, frame - index);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, Math.ceil(w / 2), Math.ceil(h / 2));
        gl.uniform1i(uniform.clipMode, 0);
        for (const [key, clips] of maskGroups) {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, masks.get(key), 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          for (const clip of clips) paint(clip, colors, true);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);
        let lastMask = null;
        for (const item of order) {
          if (colors[item * 7] <= .001 || !meshes[item].count) continue;
          const {key, flags} = meshes[item];
          if (key !== lastMask) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, masks.get(key) ?? null);
            lastMask = key;
          }
          gl.uniform1i(uniform.clipMode, key ? (flags & 8 ? 2 : 1) : 0);
          paint(item, colors, false);
        }
      },
    };
  } catch (error) {
    for (const free of dispose.reverse()) free();
    throw error;
  }
}

async function loadAtlases(atlases, signal, bitmaps, directory) {
  // Wait for all outstanding decodes before the caller releases their bitmaps.
  const results=await Promise.allSettled(atlases.map(async(atlas,index)=>{
    const response = await fetch(directory + atlas, {signal});
    if (!response.ok) throw new Error('Outfit texture unavailable');
    bitmaps[index]=await createImageBitmap(await response.blob(), {imageOrientation:'flipY', premultiplyAlpha:'none'});
  }));
  const failure=results.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
}

export function createOutfitPreview(h) {
  const sessions = new WeakMap();
  return {
    props: {asset:String,costume:String,atlases:Array,reactions:Array,updated:Boolean},
    data() { return {ready:false,reacting:false}; },
    methods:{
      async react() {
        const session = sessions.get(this);
        if (!this.ready || !this.reactions?.length || this.reacting || !session) return;
        const slot = this.reactions[session.nextReaction % this.reactions.length];
        this.reacting = true;
        try {
          const reaction = await session.decode(this.asset, slot, session.model);
          if (session.controller.signal.aborted) return;
          session.reaction = reaction;
          session.started = performance.now();
          session.nextReaction++;
        } catch (error) {
          if (!session.controller.signal.aborted) {
            this.reacting = false;
            console.warn('Outfit reaction unavailable', error);
          }
        }
      },
    },
    mounted() {
      const controller = new AbortController();
      const canvas = this.$refs.canvas;
      const session = {controller, frame:0, renderer:null, contextLost:null, nextReaction:0};
      sessions.set(this, session);
      const signal = controller.signal;
      session.contextLost = () => {
        controller.abort();
        cancelAnimationFrame(session.frame);
        this.ready = false;
      };
      canvas.addEventListener('webglcontextlost', session.contextLost);
      const start = async () => {
        const bitmaps = [];
        try {
          const directory=this.updated?'/assets/outfit-updates/':assets;
          session.decode = outfitDecoder(signal,directory);
          const modelRequest=session.decode(this.asset);
          const [mesh,textures]=await Promise.allSettled([
            modelRequest,
            this.atlases?.length?loadAtlases(this.atlases,signal,bitmaps,directory):
              modelRequest.then(model=>loadAtlases(model.atlases,signal,bitmaps,directory)),
          ]);
          if(mesh.status==='rejected')throw mesh.reason;
          if(textures.status==='rejected')throw textures.reason;
          const model=session.model=mesh.value;
          if (signal.aborted) return;
          session.renderer = makeRenderer(canvas, model, bitmaps, this.costume??this.asset);
          let startTime = performance.now();
          const paint = now => {
            const elapsed = Math.max(0, (now - session.started) / 1000);
            if (session.reaction && elapsed >= session.reaction.duration) {
              session.reaction = null;
              this.reacting = false;
              startTime = now;
            }
            session.renderer.draw(session.reaction ? elapsed : Math.max(0, (now - startTime) / 1000), session.reaction);
            session.frame = requestAnimationFrame(paint);
          };
          paint(startTime);
          this.ready = true;
        } catch (error) {
          if (!signal.aborted) {
            this.ready = false;
            console.warn('Outfit preview unavailable', error);
          }
        } finally {
          for (const bitmap of bitmaps) bitmap?.close();
        }
      };
      void start();
    },
    beforeUnmount() {
      const session = sessions.get(this);
      if (!session) return;
      session.controller.abort();
      cancelAnimationFrame(session.frame);
      this.$refs.canvas.removeEventListener('webglcontextlost', session.contextLost);
      session.renderer?.dispose();
      sessions.delete(this);
    },
    render() {
      return h('div', {class:'holo-outfit-model'}, [
        h('canvas', {ref:'canvas', class:this.ready?'holo-outfit-ready':'', 'aria-hidden':'true'}, null, 2),
        this.ready && this.reactions?.length ? h('button', {
          class:'holo-outfit-react',type:'button','aria-label':'Play outfit reaction',
          'aria-busy':this.reacting?'true':'false',onClick:this.react,
        }, null, 8, ['aria-busy']) : null,
      ]);
    },
  };
}
