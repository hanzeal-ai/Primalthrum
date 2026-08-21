export const WEB_SCRIPT = `(() => {
  const form = document.querySelector('#agent-composer');
  const input = document.querySelector('#message-input');
  const conversation = document.querySelector('#conversation');
  const sendButton = document.querySelector('#send-button');
  const recordButton = document.querySelector('#record-button');
  const speechToggle = document.querySelector('#speech-toggle');
  const status = document.querySelector('#agent-status');
  const agentName = document.querySelector('#agent-name');
  const agentDescription = document.querySelector('#agent-description');

  let busy = false;
  let speechEnabled = true;
  let recognition = null;
  let recording = false;

  function setStatus(message) {
    status.textContent = message;
  }

  function appendMessage(role, content, error) {
    const message = document.createElement('div');
    message.className = 'message message-' + role + (error ? ' message-error' : '');
    message.textContent = content;
    conversation.append(message);
    conversation.scrollTop = conversation.scrollHeight;
    return message;
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function speak(message) {
    if (!speechEnabled || !('speechSynthesis' in window) || !message) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = document.documentElement.lang || navigator.language;
    window.speechSynthesis.speak(utterance);
  }

  function parseEvent(block) {
    let event = '';
    const data = [];
    block.split('\\n').forEach((line) => {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data.push(line.slice(6));
    });
    if (!event || data.length === 0) return null;
    return { event, payload: JSON.parse(data.join('\\n')) };
  }

  async function consumeStream(response, agentMessage) {
    if (!response.body) throw new Error('Streaming is unavailable.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = '';

    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
      const blocks = buffer.split('\\n\\n');
      buffer = blocks.pop() || '';

      blocks.forEach((block) => {
        const message = parseEvent(block);
        if (!message) return;
        if (message.event === 'message.delta') {
          agentMessage.textContent += message.payload.delta || '';
          conversation.scrollTop = conversation.scrollHeight;
        }
        if (message.event === 'message.completed') {
          completed = message.payload.content || agentMessage.textContent;
        }
        if (message.event === 'agent.run.failed') {
          throw new Error(message.payload.message || 'Agent request failed.');
        }
      });

      if (result.done) break;
    }

    return completed || agentMessage.textContent;
  }

  async function submitMessage(message) {
    if (busy || !message) return;
    busy = true;
    sendButton.disabled = true;
    input.disabled = true;
    appendMessage('user', message);
    const agentMessage = appendMessage('agent', '');
    setStatus('思考中');

    try {
      const response = await fetch('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error('Request failed with status ' + response.status + '.');
      const answer = await consumeStream(response, agentMessage);
      speak(answer);
      setStatus('在线');
    } catch (error) {
      agentMessage.classList.add('message-error');
      agentMessage.textContent = error instanceof Error ? error.message : 'Agent request failed.';
      setStatus('请求失败');
    } finally {
      busy = false;
      sendButton.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  function configureSpeechInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      recordButton.hidden = true;
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      input.value = transcript;
      resizeInput();
    };
    recognition.onerror = () => setStatus('语音输入失败');
    recognition.onend = () => {
      recording = false;
      recordButton.classList.remove('recording');
      recordButton.setAttribute('aria-pressed', 'false');
      if (status.textContent !== '语音输入失败') setStatus('在线');
    };
  }

  async function loadAgent() {
    try {
      const response = await fetch('/api/agent');
      if (!response.ok) throw new Error('Agent metadata is unavailable.');
      const agent = await response.json();
      agentName.textContent = agent.name || 'Agent';
      agentDescription.textContent = agent.description || '';
      document.title = agent.name || 'Agent';
      appendMessage('agent', '你好，我是 ' + (agent.name || 'Agent') + '。');
      setStatus('在线');
    } catch (error) {
      setStatus('连接失败');
      appendMessage('agent', error instanceof Error ? error.message : 'Agent is unavailable.', true);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    resizeInput();
    void submitMessage(message);
  });

  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  speechToggle.addEventListener('click', () => {
    speechEnabled = !speechEnabled;
    speechToggle.setAttribute('aria-pressed', String(speechEnabled));
    if (!speechEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  });

  recordButton.addEventListener('click', () => {
    if (!recognition || busy) return;
    if (recording) {
      recognition.stop();
      return;
    }
    recording = true;
    recordButton.classList.add('recording');
    recordButton.setAttribute('aria-pressed', 'true');
    setStatus('聆听中');
    recognition.start();
  });

  configureSpeechInput();
  resizeInput();
  void loadAgent();
})();
`;
