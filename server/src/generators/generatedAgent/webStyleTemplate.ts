export const WEB_STYLES = `:root {
  color: #17201c;
  background: #f4f6f5;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
}

button,
textarea {
  font: inherit;
  letter-spacing: 0;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.agent-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(100%, 920px);
  min-height: 100vh;
  margin: 0 auto;
  background: #ffffff;
  border-inline: 1px solid #dce3df;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 72px;
  padding: 14px 24px;
  border-bottom: 1px solid #dce3df;
}

.agent-header h1 {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 18px;
  line-height: 1.35;
}

.agent-header p {
  max-width: 620px;
  margin: 4px 0 0;
  overflow-wrap: anywhere;
  color: #637069;
  font-size: 13px;
  line-height: 1.4;
}

.status {
  flex: 0 0 auto;
  color: #277454;
  font-size: 12px;
  font-weight: 650;
}

.conversation {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  padding: 28px 24px 40px;
  overflow-y: auto;
}

.message {
  width: fit-content;
  max-width: min(78%, 680px);
  padding: 11px 14px;
  border-radius: 8px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.6;
}

.message-user {
  align-self: flex-end;
  color: #ffffff;
  background: #23684d;
}

.message-agent {
  align-self: flex-start;
  color: #17201c;
  background: #edf1ef;
}

.message-error {
  color: #8d2525;
  background: #fff0f0;
}

.agent-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
  padding: 16px 24px calc(16px + env(safe-area-inset-bottom));
  border-top: 1px solid #dce3df;
  background: #ffffff;
}

.agent-composer textarea {
  width: 100%;
  min-height: 44px;
  max-height: 160px;
  padding: 10px 12px;
  resize: none;
  color: #17201c;
  background: #f8faf9;
  border: 1px solid #cbd5d0;
  border-radius: 6px;
  outline: none;
  line-height: 1.5;
}

.agent-composer textarea:focus {
  border-color: #277454;
  box-shadow: 0 0 0 3px rgba(39, 116, 84, 0.14);
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.icon-button,
.send-button {
  height: 40px;
  border: 1px solid #cbd5d0;
  border-radius: 6px;
}

.icon-button {
  display: inline-grid;
  place-items: center;
  width: 40px;
  padding: 0;
  color: #35423c;
  background: #ffffff;
  font-size: 13px;
  font-weight: 700;
}

.icon-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.icon-button[aria-pressed="true"] {
  color: #ffffff;
  background: #35423c;
  border-color: #35423c;
}

.icon-button.recording {
  color: #ffffff;
  background: #a83434;
  border-color: #a83434;
}

.send-button {
  min-width: 72px;
  padding: 0 18px;
  color: #ffffff;
  background: #23684d;
  border-color: #23684d;
  font-weight: 650;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 640px) {
  .agent-shell {
    border: 0;
  }

  .agent-header {
    min-height: 64px;
    padding: 12px 16px;
  }

  .agent-header p {
    display: none;
  }

  .conversation {
    padding: 20px 16px 28px;
  }

  .message {
    max-width: 88%;
  }

  .agent-composer {
    grid-template-columns: 1fr;
    gap: 8px;
    padding-inline: 16px;
  }

  .composer-actions {
    justify-content: flex-end;
  }
}
`;
