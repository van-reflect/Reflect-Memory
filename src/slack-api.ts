/**
 * Thin typed wrappers around the Slack Web API endpoints we use.
 * Keep these dependency-free and side-effect free so they're easy to mock in
 * tests. All error handling surfaces a discriminated union; callers decide
 * whether to retry, give up, or surface to the user.
 */

const SLACK_API = "https://slack.com/api";

export type SlackResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface SlackUserInfoResult {
  email: string | null;
  realName: string | null;
  displayName: string | null;
  isBot: boolean;
  isDeleted: boolean;
}

/**
 * Looks up a Slack user by their Slack user ID. Returns the email (which we
 * use to match to a Reflect user) plus a couple of display fields. Email may
 * be null if the workspace admin has revoked the `users:read.email` scope.
 */
export async function slackUsersInfo(
  botToken: string,
  slackUserId: string,
): Promise<SlackResult<SlackUserInfoResult>> {
  const params = new URLSearchParams({ user: slackUserId });
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/users.info?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
    });
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : err}` };
  }
  let data: {
    ok?: boolean;
    error?: string;
    user?: {
      profile?: { email?: string | null; real_name?: string | null; display_name?: string | null };
      is_bot?: boolean;
      deleted?: boolean;
    };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { ok: false, error: `parse: ${err instanceof Error ? err.message : err}` };
  }
  if (!data.ok) {
    return { ok: false, error: data.error ?? "users.info returned ok=false" };
  }
  const user = data.user ?? {};
  return {
    ok: true,
    data: {
      email: user.profile?.email ?? null,
      realName: user.profile?.real_name ?? null,
      displayName: user.profile?.display_name ?? null,
      isBot: user.is_bot === true,
      isDeleted: user.deleted === true,
    },
  };
}

interface PostMessageResult {
  ts: string;
  channel: string;
}

/**
 * Posts a message to a channel or DM. If `threadTs` is set, posts as a reply
 * in that thread.
 */
export async function slackChatPostMessage(
  botToken: string,
  options: { channel: string; text: string; threadTs?: string | null },
): Promise<SlackResult<PostMessageResult>> {
  const body: Record<string, unknown> = {
    channel: options.channel,
    text: options.text,
  };
  if (options.threadTs) body.thread_ts = options.threadTs;

  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : err}` };
  }
  let data: { ok?: boolean; error?: string; ts?: string; channel?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { ok: false, error: `parse: ${err instanceof Error ? err.message : err}` };
  }
  if (!data.ok || !data.ts || !data.channel) {
    return { ok: false, error: data.error ?? "chat.postMessage returned ok=false" };
  }
  return { ok: true, data: { ts: data.ts, channel: data.channel } };
}

/**
 * Posts an ephemeral message visible only to one user in a channel. We use
 * this for refusals when the requester's email doesn't match a Reflect user
 * — keeps the channel clean for everyone else.
 */
export async function slackPostEphemeral(
  botToken: string,
  options: { channel: string; user: string; text: string },
): Promise<SlackResult<{ messageTs: string }>> {
  const body = {
    channel: options.channel,
    user: options.user,
    text: options.text,
  };
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/chat.postEphemeral`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : err}` };
  }
  let data: { ok?: boolean; error?: string; message_ts?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { ok: false, error: `parse: ${err instanceof Error ? err.message : err}` };
  }
  if (!data.ok) {
    return { ok: false, error: data.error ?? "chat.postEphemeral returned ok=false" };
  }
  return { ok: true, data: { messageTs: data.message_ts ?? "" } };
}
