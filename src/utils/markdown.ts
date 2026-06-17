import MarkdownIt from 'markdown-it';

// `html: false` keeps raw HTML in the source from being injected into the webview.
const md: MarkdownIt = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Tag every block-level element with its source line range so a selection in the rendered
// view can be mapped back to lines in the markdown file (data-line is 0-based inclusive
// start; data-line-end is the markdown-it exclusive end).
md.core.ruler.push('co_steer_line_anchors', state => {
    for (const token of state.tokens) {
        if (token.map && token.nesting !== -1) {
            token.attrSet('data-line', String(token.map[0]));
            token.attrSet('data-line-end', String(token.map[1]));
        }
    }
    return true;
});

/** Render markdown source to HTML whose block elements carry source-line anchors. */
export function renderMarkdownToHtml(source: string): string {
    return md.render(source);
}
