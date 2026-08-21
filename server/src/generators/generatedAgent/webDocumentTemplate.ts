export const WEB_DOCUMENT = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>Agent</title>
    <link rel="stylesheet" href="/assets/styles.css" />
  </head>
  <body>
    <div class="agent-shell">
      <header class="agent-header">
        <div>
          <h1 id="agent-name">Agent</h1>
          <p id="agent-description"></p>
        </div>
        <span class="status" id="agent-status">连接中</span>
      </header>

      <main class="conversation" id="conversation" aria-live="polite"></main>

      <form class="agent-composer" id="agent-composer">
        <label class="sr-only" for="message-input">消息</label>
        <textarea
          id="message-input"
          maxlength="8000"
          placeholder="输入消息"
          rows="1"
          required
        ></textarea>
        <div class="composer-actions">
          <button
            class="icon-button"
            id="speech-toggle"
            type="button"
            aria-label="语音播报"
            aria-pressed="true"
            title="语音播报"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M11 5 6 9H2v6h4l5 4Z"></path>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
            </svg>
          </button>
          <button
            class="icon-button"
            id="record-button"
            type="button"
            aria-label="语音输入"
            title="语音输入"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect width="8" height="12" x="8" y="2" rx="4"></rect>
              <path d="M4 10a8 8 0 0 0 16 0"></path>
              <path d="M12 18v4"></path>
            </svg>
          </button>
          <button class="send-button" id="send-button" type="submit">发送</button>
        </div>
      </form>
    </div>
    <script src="/assets/app.js" defer></script>
  </body>
</html>
`;
