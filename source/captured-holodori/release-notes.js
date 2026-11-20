import {Lexer} from 'marked';

export function parseReleaseNotes(notes) {
  return Lexer.lex(notes);
}

export function renderReleaseNotes(h, tokens) {
  const entity = /&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]+);/g;
  let decoder;
  const decode = text => text.replace(entity, match => {
    decoder ??= document.createElement('textarea');
    decoder.innerHTML = match;
    return decoder.value;
  });
  const children = items => items.map(node).filter(child => child !== null);

  // Render only known Markdown tokens. Raw HTML and image descriptions are text.
  function node(token) {
    switch (token.type) {
      case 'space': return null;
      case 'heading': return h(`h${Math.min(6, Math.max(3, token.depth + 1))}`, null, children(token.tokens));
      case 'paragraph': return h('p', null, children(token.tokens));
      case 'blockquote': return h('blockquote', null, children(token.tokens));
      case 'list': return h(token.ordered ? 'ol' : 'ul', token.ordered ? {start:token.start} : null, children(token.items));
      case 'list_item': return h('li', null, children(token.tokens));
      case 'strong':
      case 'em':
      case 'del': return h(token.type, null, children(token.tokens));
      case 'code': return h('pre', null, [h('code', null, token.text + '\n')]);
      case 'codespan': return h('code', null, token.text);
      case 'br': return h('br');
      case 'hr': return h('hr');
      case 'link': {
        const label = children(token.tokens);
        const href = decode(token.href);
        let url;
        try { url = new URL(href); } catch { /* Render invalid destinations as text. */ }
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return h('span', null, label);
        return h('a', {href:url.href, title:token.title ?? undefined, target:'_blank', rel:'noopener noreferrer'}, label);
      }
      case 'image': return decode(token.text);
      case 'text': return token.tokens ? h('span', null, children(token.tokens)) : decode(token.text);
      default: return token.raw;
    }
  }

  return children(tokens);
}
