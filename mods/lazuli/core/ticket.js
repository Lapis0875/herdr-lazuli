// The ticket an agent works on (ARCHITECTURE §4.2, CONTRACTS ticket.js): the first tracker link in its PR's body
// (Linear, Jira, GitHub issue), else a `KEY-123` in its branch name, which has no link. Pure.

const URL_CHARS = String.raw`[^\s<>"'\]]`;
const PART = String.raw`[^\s/<>"'\]]+`;
const END = String.raw`(?=[/?#.,)\s<>"'\]]|$)`;
const KEY = String.raw`[A-Za-z][A-Za-z0-9_]*-\d+`;

// One alternation, so the leftmost link in the body wins whatever its tracker.
const LINK = new RegExp(
  [
    String.raw`(?<linear>https?://linear\.app/${PART}/issue/(?<linearKey>${KEY})${END}${URL_CHARS}*)`,
    String.raw`(?<jira>https?://${PART}/browse/(?<jiraKey>${KEY})${END}${URL_CHARS}*)`,
    String.raw`(?<github>https?://github\.com/(?<owner>${PART})/(?<name>${PART})/issues/(?<number>\d+)${END}${URL_CHARS}*)`,
  ].join("|"),
);

const BRANCH_KEY = /(?:^|[/_-])([A-Za-z]{2,10}-\d+)(?=$|[/_-])/;

/** The URL as written, without the sentence's trailing `.`, `,` or `)`. */
const trimUrl = (url) => url.replace(/[.,)]+$/, "");

/** `{key, url}` from the PR body's first tracker link, else `{key, url: null}` from the branch, else null. */
export function ticketOf(o) {
  const body = typeof o?.body === "string" ? o.body : "";
  const m = body ? LINK.exec(body) : null;
  if (m) {
    const g = m.groups;
    if (g.linear) return { key: g.linearKey, url: trimUrl(g.linear) };
    if (g.jira) return { key: g.jiraKey, url: trimUrl(g.jira) };
    if (g.github) return { key: `${g.owner}/${g.name}#${g.number}`, url: trimUrl(g.github) };
  }
  const branch = typeof o?.branch === "string" ? o.branch : "";
  const b = branch ? BRANCH_KEY.exec(branch) : null;
  return b ? { key: b[1].toUpperCase(), url: null } : null;
}
