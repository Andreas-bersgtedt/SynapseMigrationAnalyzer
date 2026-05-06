import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { Link } from "react-router-dom";

interface Props {
  source: string;
}

/**
 * Rewrites a markdown link target so that internal links to other user-guide
 * chapters (`05-code-objects.md`, `12-configuration.md#save`) become SPA
 * routes (`/help/05-code-objects`, `/help/12-configuration#save`). External
 * URLs and pure anchor links pass through unchanged.
 */
function rewriteHref(href: string): { internal: boolean; href: string } {
  if (!href) return { internal: false, href };
  // Pure anchor: keep as-is.
  if (href.startsWith("#")) return { internal: true, href };
  // External: http(s), mailto, etc.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { internal: false, href };
  // Repo-root docs referenced from a user-guide chapter as `../../FILE.md`.
  // The matching chapters are bundled with slug `repo-<lower>` (see
  // `web/src/help/chapters.ts`).
  const repoMatch = href.match(/^(?:\.\.\/)+(README|QUICKSTART|CHANGELOG|SECURITY)\.md(#.*)?$/i);
  if (repoMatch) {
    const slug = `repo-${repoMatch[1].toLowerCase()}`;
    const anchor = repoMatch[2] || "";
    return { internal: true, href: `/help/${slug}${anchor}` };
  }
  // Strip a leading ./ for normalisation.
  const target = href.replace(/^\.\//, "");
  // Match `<slug>.md` or `<slug>.md#anchor`.
  const m = target.match(/^([A-Za-z0-9_-]+)\.md(#.*)?$/);
  if (m) {
    const slug = m[1];
    const anchor = m[2] || "";
    return { internal: true, href: `/help/${slug}${anchor}` };
  }
  // Anything else escapes out — let it open externally.
  return { internal: false, href };
}

export default function Markdown({ source }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          a: ({ href, children, ...rest }) => {
            const { internal, href: target } = rewriteHref(href || "");
            if (internal && target.startsWith("/help/")) {
              return <Link to={target}>{children}</Link>;
            }
            if (internal) {
              return <a href={target}>{children}</a>;
            }
            return (
              <a href={target} target="_blank" rel="noreferrer noopener" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
