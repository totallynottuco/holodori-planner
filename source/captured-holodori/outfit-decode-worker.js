async function loadCompressed(directory, file) {
  const response = await fetch(directory + file);
  if (!response.ok || !response.body) throw new Error('Outfit mesh unavailable');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function loadMesh(directory, id) {
  const raw = await loadCompressed(directory, id + '.mesh.gz');
  const length = new DataView(raw).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, length)));
  if (meta.format !== 2) throw new Error('Unsupported outfit mesh format');
  const offset = 4 + Math.ceil(length / 4) * 4;
  const coordinates = new Float32Array(raw, offset, meta.vertexCount * 2);
  const indices = new Uint32Array(raw, offset + coordinates.byteLength, meta.indexCount);
  const frames = decodeFrames(raw, offset + coordinates.byteLength + indices.byteLength,
    coordinates.length, meta.meshes.length, meta.frameCount);
  return {...meta, coordinates, indices, frames};
}

function decodeFrames(raw, dataOffset, vertexValues, meshCount, frameCount) {
  const deltas = new Int16Array(raw, dataOffset, vertexValues * frameCount);
  const orderOffset = dataOffset + deltas.byteLength;
  const colorOffset = orderOffset + frameCount * meshCount * 2;
  const frames = Array.from({length:frameCount}, (_, i) => {
    const points = new Float32Array(vertexValues);
    const order = new Uint16Array(raw, orderOffset + i * meshCount * 2, meshCount);
    const colors = Float32Array.from(new Uint8Array(raw, colorOffset + i * meshCount * 7, meshCount * 7),
      value => value / 255);
    return {points, order, colors};
  });
  for (let vertex = 0; vertex < vertexValues; vertex++) {
    let point = 0;
    for (let i = 0; i < frameCount; i++) {
      point += deltas[vertex * frameCount + i];
      frames[i].points[vertex] = point / 4096;
    }
  }
  return frames;
}

async function loadReaction(directory, asset, slot, geometry) {
  const raw = await loadCompressed(directory, `${asset}.reaction-${slot}.gz`);
  const header = new DataView(raw);
  return {duration:header.getFloat32(4, true),
    frames:decodeFrames(raw, 8, geometry.vertexValues, geometry.meshCount, header.getUint32(0, true))};
}


self.onmessage = async ({data}) => {
  const {asset,slot,directory,geometry} = data;
  try {
    const clip = slot === undefined ? await loadMesh(directory, asset) :
      await loadReaction(directory, asset, slot, geometry);
    const transfer = new Set(clip.frames.flatMap(({points, order, colors}) =>
      [points.buffer, order.buffer, colors.buffer]));
    if (clip.coordinates) transfer.add(clip.coordinates.buffer);
    self.postMessage({clip}, [...transfer]);
  } catch (error) {
    self.postMessage({error:String(error)});
  }
};
