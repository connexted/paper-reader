# Optional connections

Paper's reader needs a FreshRSS instance with the Google Reader API enabled.
All other connections can be left disabled. Never commit authentication files,
tokens, or a real .env. Open Settings > Reading & connections to enable or disable
AI, Readwise Reader, and Kirby notes. Changes take effect without restarting
Paper. The same settings apply to every device using this server.

Settings accepts Readwise and Kirby tokens. Password fields stay blank after
saving; blank means keep the current token. Remove token clears it when you
save and prevents fallback to an environment token. Turning a connection off
keeps its credentials so you can enable it again later.

Paper saves overrides in STATE_DIR/connections.json, normally data/connections.json,
with owner-only permissions, mode 0600. Tokens are not encrypted at rest.
Settings responses never include tokens. Protect the data directory and its
backups as secret material. Environment values remain the defaults for fields
you have not saved. Saved fields take precedence after a restart, including
for the briefing CLI. To return entirely to environment configuration, stop
Paper, preserve a private copy of connections.json, then move it out of STATE_DIR
before starting Paper again.

## FreshRSS helpers

Feed health and custom folder order use integrations/paper-feed-health.php.
Feed repair uses integrations/paper-feed-repair.php. For the official FreshRSS
Docker image, mount these files read-only at:

```yaml
volumes:
  - ./paper/integrations/paper-feed-health.php:/var/www/FreshRSS/p/api/paper-feed-health.php:ro
  - ./paper/integrations/paper-feed-repair.php:/var/www/FreshRSS/p/api/paper-feed-repair.php:ro
```

Adapt the source paths to your checkout. Apply changes to your FreshRSS stack
deliberately. Both endpoints use its existing API authentication. Core reading
works without them. Feed repair reports that the helper needs installation when
it is absent. The integration test uses FreshRSS 1.30.4.

## Readwise and Kirby

In Settings, enable Readwise Reader, paste a token from
[your Readwise token page](https://readwise.io/access_token), choose a destination,
and save. Use the Readwise button on an article to save its URL and title.
Paper does not import your Reader library or highlights. The
[Reader API documentation](https://readwise.io/reader_api) describes token access
and supported locations. Reader uses your default destination when the selected
one is unavailable in your account.

READWISE_TOKEN and READWISE_LOCATION also work as server-side defaults.
READWISE_LOCATION defaults to later.

For Kirby, install a compatible publishing endpoint on your own site, then enter
its URL and bearer token in Settings and enable Kirby notes. Kirby's standard API
alone is not compatible. Obtain the token from your publishing plugin's
configuration, not an unrelated Kirby account credential. There is no default
publishing host. Use HTTPS unless you control the private network.

Selecting a quote and choosing Create note in Kirby sends it with the article
title and URL. The endpoint must accept multipart form data with a payload field
containing JSON with title, destination set to notes, and Markdown text, using
Authorization: Bearer <token>. Return JSON with ok set to true and a page id or
slug, plus an optional url. Configure that endpoint to create drafts.
src/server/kirby.ts defines the payload. KIRBY_PUBLISH_URL and KIRBY_PUBLISH_TOKEN
remain available as environment defaults.

## RSSHub and private feed proxies

RSSHUB_BASE_URL enables the X thread lookup connection. A private RSSHub or feed
proxy is your own dependency and is not included with Paper.

PAPER_TRUSTED_FEED_ORIGINS accepts exact comma-separated HTTP/HTTPS origins,
such as https://feeds.example.com. An entry permits feed-preview requests to
that origin even when it resolves privately, and permits recognized social-feed
routes there to supply avatars. Include only origins you control. Paths,
embedded credentials, and wildcard hosts are not accepted. Other feed previews
and full-text requests reject private network destinations.

## AI

CODEX_ENABLED and OPENCODE_ENABLED default to false. Settings provides a master
AI switch, provider switches, and individual switches for discussions, headline
cleanup, Pulse grouping, and briefing generation. Turning AI off stops new model
requests and cancels active discussions. A batch request already running may
finish; disabled features do not start its next review or batch. Existing
discussions, briefings, and collections remain stored. There are no AI credentials
or CLI tools in the default reader image. AI model calls send article text to
the selected provider. Enabling grouping or headline cleanup can make background
requests after synchronization. Enabling a CLI does not itself enable every
model on an account. Set model names that your account can access.

For a native Node installation, install and authenticate the desired CLI using
its official instructions, then set its executable path. The Codex connection
uses its batch CLI and app-server; OpenCode is a briefing/grouping fallback.
Article discussions and headline review currently require Codex.

The optional compose.ai.yaml uses the AI image with pinned CLI packages. Run:

```sh
mkdir -p ai-auth/codex ai-auth/opencode
docker compose -f compose.yaml -f compose.ai.yaml pull paper
docker compose -f compose.yaml -f compose.ai.yaml run --rm --no-deps paper codex login --device-auth
```

Its authentication directory is ./ai-auth/codex, separate from your host login.
It is private writable state so the CLI can refresh its login. Authenticate
OpenCode separately with its official CLI if you use that fallback. Its login
command inside the same container is opencode auth login. Start Paper:

```sh
docker compose -f compose.yaml -f compose.ai.yaml up -d --no-build paper
```

Enable the provider and desired features in Settings.
Paper uses the CLI login stores; it does not accept AI tokens in Settings.
Switches do not verify login or model access. The CLI package installation is checked during image building; this
release does not exercise a live provider account or make billable model calls.

The default editorial profile is in recap/editorial-profile.md. Mount a private
replacement there if you want personalized briefings. Model subprocesses omit
Paper's FreshRSS, Readwise, Kirby, and automation secrets from their environment.

Official setup and authentication guidance:

- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/auth
- https://opencode.ai/docs/

## Folder digests

A folder digest summarizes the last 24 hours of one FreshRSS folder, such as
Gaming. It uses the same AI provider and Briefing generation switch as the
briefings. Without AI it stores a plain list of the new articles. Digests
appear in Briefings as "Daily digest" and never count as delivered briefings.

```sh
docker compose exec paper node dist-server/digest-cli.js Gaming --hours 24 --language Dutch
```

Run it from cron or another scheduler for a daily digest. The folder name is
matched case-insensitively; an unknown name lists the available folders.

## Full-text fallback

PAPER_READER_FALLBACK_ENABLED defaults to false. Setting it to true permits
blocked or unreadable article URLs to be sent to https://r.jina.ai for extraction.
Leave it disabled if you want full-text requests to contact only the publisher.

## Email automation

Paper provides a briefing CLI and internal HTTP endpoints. It does not include
an SMTP account, recipient, or active n8n workflow. A scheduler can call
POST /api/internal/briefings/generate with x-paper-secret and a JSON body such as
{"kind":"morning"}. The render and delivered endpoints are documented by the
routes in src/server/index.ts. Keep the secret in the scheduler's credential
store. If using the authenticated proxy, automation must satisfy proxy
authentication as well or use a restricted internal network route.

Briefing confirmation links use PUBLIC_URL. Use your actual HTTPS reader URL
and configure TZ for email dates. PAPER_BRIEFING_INCLUDE_READ_UNTIL normally
stays blank, which keeps briefings limited to unread candidates.
