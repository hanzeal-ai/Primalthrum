import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  clearStoredSessionToken,
  createDocument,
  createAgent,
  createProviderConfig,
  generateAgentProject,
  getCurrentSession,
  getSetupStatus,
  indexDocument,
  isUnauthorizedError,
  listAgents,
  listDocuments,
  listProviderConfigs,
  listProviders,
  listSkills,
  listTools,
  loginAdmin,
  logoutAdmin,
  setupAdmin,
  streamAgentRun,
  updateProviderConfig,
} from './api/client'
import type {
  AgentRecord,
  AuthUser,
  DocumentRecord,
  ProviderCatalog,
  ProviderConfigRecord,
  RunStatus,
  SkillInfo,
  StreamPayload,
  ToolInfo,
} from './api/types'
import './App.css'

interface TimelineEvent extends StreamPayload {
  id: number
  event: string
  receivedAt: string
}

type AuthMode = 'checking' | 'setup' | 'login' | 'ready'

interface AuthFormState {
  email: string
  password: string
}

const DEFAULT_AUTH_FORM: AuthFormState = {
  email: 'admin@example.com',
  password: '',
}

const DEFAULT_FORM = {
  agent: 'ResearchAgent',
  goal: 'Create a research agent that can plan tasks, collect evidence, and stream progress to the product UI.',
  tools: 'planner, memory, file_search',
}

interface AgentFormState {
  name: string
  description: string
  memoryProvider: string
  cacheProvider: string
  ragProvider: string
  enabledTools: string[]
  enabledSkills: string[]
}

const DEFAULT_AGENT_FORM: AgentFormState = {
  name: 'Research Agent',
  description: 'Research assistant with memory, tools, and optional RAG.',
  memoryProvider: 'null',
  cacheProvider: 'memory',
  ragProvider: 'none',
  enabledTools: ['file_reader'],
  enabledSkills: ['research'],
}

const DEFAULT_DOCUMENT_FORM = {
  filename: 'guide.md',
  collection: 'research',
  content: '# Guide\nAdd retrieval-ready knowledge here.',
}

interface ProviderConfigFormState {
  id: number | null
  name: string
  type: string
  provider: string
  model: string
  secret: string
}

const DEFAULT_PROVIDER_CONFIG_FORM: ProviderConfigFormState = {
  id: null,
  name: 'openai-production',
  type: 'llm',
  provider: 'openai',
  model: 'gpt-5-mini',
  secret: '',
}

function statusLabel(status: RunStatus): string {
  if (status === 'running') return 'Running'
  if (status === 'done') return 'Complete'
  if (status === 'error') return 'Error'
  return 'Idle'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function compactSecretRef(secretRef: string): string {
  if (!secretRef) return 'No secret reference'
  const suffix = secretRef.slice(-8)
  return `secret://local/...${suffix}`
}

export default function App() {
  const [authMode, setAuthMode] = useState<AuthMode>('checking')
  const [authForm, setAuthForm] = useState(DEFAULT_AUTH_FORM)
  const [authMessage, setAuthMessage] = useState('Checking session')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [agentForm, setAgentForm] = useState(DEFAULT_AGENT_FORM)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null)
  const [agentsStatus, setAgentsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [agentsMessage, setAgentsMessage] = useState('Loading agents')
  const [providers, setProviders] = useState<ProviderCatalog | null>(null)
  const [toolsCatalog, setToolsCatalog] = useState<ToolInfo[]>([])
  const [skillsCatalog, setSkillsCatalog] = useState<SkillInfo[]>([])
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [builderMessage, setBuilderMessage] = useState('Loading builder options')
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [documentForm, setDocumentForm] = useState(DEFAULT_DOCUMENT_FORM)
  const [knowledgeStatus, setKnowledgeStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [knowledgeMessage, setKnowledgeMessage] = useState('Select an agent to manage documents')
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigRecord[]>([])
  const [providerConfigForm, setProviderConfigForm] = useState(DEFAULT_PROVIDER_CONFIG_FORM)
  const [securityStatus, setSecurityStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [securityMessage, setSecurityMessage] = useState('Security settings not loaded')
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [status, setStatus] = useState<RunStatus>('idle')
  const [summary, setSummary] = useState<StreamPayload>({})
  const abortRef = useRef<AbortController | null>(null)
  const eventIdRef = useRef(1)

  const latestMessage = events.at(-1)?.message ?? 'Ready to stream an agent run.'
  const hasOutput = events.length > 0
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const dangerousTools = toolsCatalog.filter((tool) => tool.dangerous)
  const selectedDangerousTools = toolsCatalog
    .filter((tool) => tool.dangerous && agentForm.enabledTools.includes(tool.name))
    .map((tool) => tool.name)

  useEffect(() => {
    void initializeAuth()
  }, [])

  useEffect(() => {
    if (authMode !== 'ready') return

    void refreshAgents()
    void refreshBuilderCatalog()
    void refreshSecuritySettings()
    // Initial console data should load only when auth enters the ready state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authMode])

  const visibleArtifacts = useMemo(() => {
    return {
      tools: summary.tools ?? [],
      plan: summary.plan ?? [],
      artifacts: summary.artifacts ?? [],
      checks: summary.checks ?? [],
    }
  }, [summary])

  async function initializeAuth() {
    setAuthMode('checking')
    setAuthMessage('Checking session')

    try {
      const setupStatus = await getSetupStatus()
      if (setupStatus.needsSetup) {
        setAuthMode('setup')
        setAuthMessage('Create the first admin account')
        return
      }

      const session = await getCurrentSession()
      setAuthUser(session.user)
      setAuthMode('ready')
      setAuthMessage(`Signed in as ${session.user.email}`)
    } catch (error) {
      clearStoredSessionToken()
      setAuthUser(null)
      setAuthMode('login')
      setAuthMessage(
        isUnauthorizedError(error)
          ? 'Sign in to continue'
          : errorMessage(error, 'Unable to check session'),
      )
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = authForm.email.trim()
    const password = authForm.password

    if (!email || !password) {
      setAuthMessage('Email and password are required')
      return
    }

    setAuthMessage(authMode === 'setup' ? 'Creating admin account' : 'Signing in')
    try {
      const response = authMode === 'setup'
        ? await setupAdmin({ email, password })
        : await loginAdmin({ email, password })
      setAuthUser(response.user)
      setAuthForm(DEFAULT_AUTH_FORM)
      setAuthMode('ready')
      setAuthMessage(`Signed in as ${response.user.email}`)
    } catch (error) {
      setAuthMessage(errorMessage(error, 'Authentication failed'))
    }
  }

  async function handleLogout() {
    await logoutAdmin()
    clearAuthenticatedState()
    setAuthMode('login')
    setAuthMessage('Signed out')
  }

  function clearAuthenticatedState() {
    setAuthUser(null)
    setAgents([])
    setSelectedAgentId(null)
    setProviders(null)
    setToolsCatalog([])
    setSkillsCatalog([])
    setDocuments([])
    setProviderConfigs([])
    setProviderConfigForm(DEFAULT_PROVIDER_CONFIG_FORM)
    setEvents([])
    setSummary({})
    setStatus('idle')
  }

  function handleRequestError(error: unknown, fallback: string): string {
    if (isUnauthorizedError(error)) {
      clearStoredSessionToken()
      clearAuthenticatedState()
      setAuthMode('login')
      setAuthMessage('Session expired. Sign in again.')
      return 'Session expired. Sign in again.'
    }

    return errorMessage(error, fallback)
  }

  async function refreshAgents() {
    setAgentsStatus('loading')
    setAgentsMessage('Loading agents')
    try {
      const nextAgents = await listAgents()
      setAgents(nextAgents)
      setAgentsStatus('ready')
      setAgentsMessage(`${nextAgents.length} agents available`)
    } catch (error) {
      setAgentsStatus('error')
      setAgentsMessage(handleRequestError(error, 'Failed to load agents'))
    }
  }

  async function refreshBuilderCatalog() {
    setCatalogStatus('loading')
    setBuilderMessage('Loading builder options')
    try {
      const [nextProviders, nextTools, nextSkills] = await Promise.all([
        listProviders(),
        listTools(),
        listSkills(),
      ])
      setProviders(nextProviders)
      setToolsCatalog(nextTools)
      setSkillsCatalog(nextSkills)
      setCatalogStatus('ready')
      setBuilderMessage('Builder options ready')
    } catch (error) {
      setCatalogStatus('error')
      setBuilderMessage(handleRequestError(error, 'Failed to load builder options'))
    }
  }

  async function refreshSecuritySettings() {
    setSecurityStatus('loading')
    setSecurityMessage('Loading security settings')
    try {
      const nextConfigs = await listProviderConfigs()
      setProviderConfigs(nextConfigs)
      setSecurityStatus('idle')
      setSecurityMessage(`${nextConfigs.length} provider configs saved`)
    } catch (error) {
      setSecurityStatus('error')
      setSecurityMessage(handleRequestError(error, 'Failed to load security settings'))
    }
  }

  async function handleSaveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = providerConfigForm.name.trim()
    const type = providerConfigForm.type.trim()
    const provider = providerConfigForm.provider.trim()
    const model = providerConfigForm.model.trim()
    const secret = providerConfigForm.secret

    if (!name || !type || !provider) {
      setSecurityStatus('error')
      setSecurityMessage('Name, type, and provider are required.')
      return
    }

    if (!providerConfigForm.id && !secret.trim()) {
      setSecurityStatus('error')
      setSecurityMessage('Secret is required when creating a provider config.')
      return
    }

    setSecurityStatus('loading')
    setSecurityMessage(providerConfigForm.id ? 'Updating provider config' : 'Creating provider config')
    try {
      const config = model ? { provider, model } : { provider }
      const saved = providerConfigForm.id
        ? await updateProviderConfig(providerConfigForm.id, {
          name,
          type,
          config,
          ...(secret.trim() ? { secret } : {}),
        })
        : await createProviderConfig({
          name,
          type,
          config,
          secret,
        })

      setProviderConfigs((current) => {
        const exists = current.some((item) => item.id === saved.id)
        return exists
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved]
      })
      setProviderConfigForm(DEFAULT_PROVIDER_CONFIG_FORM)
      setSecurityStatus('idle')
      setSecurityMessage(`Saved ${saved.name}`)
    } catch (error) {
      setSecurityStatus('error')
      setSecurityMessage(handleRequestError(error, 'Failed to save provider config'))
    }
  }

  function editProviderConfig(config: ProviderConfigRecord) {
    setProviderConfigForm({
      id: config.id,
      name: config.name,
      type: config.type,
      provider: typeof config.config.provider === 'string' ? config.config.provider : '',
      model: typeof config.config.model === 'string' ? config.config.model : '',
      secret: '',
    })
    setSecurityMessage(`Editing ${config.name}. Existing secret is hidden.`)
  }

  function updateProviderConfigForm<K extends keyof ProviderConfigFormState>(
    key: K,
    value: ProviderConfigFormState[K],
  ) {
    setProviderConfigForm((current) => ({ ...current, [key]: value }))
  }

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = agentForm.name.trim()
    const description = agentForm.description.trim()

    if (!name) {
      setAgentsStatus('error')
      setAgentsMessage('Agent name is required.')
      return
    }

    setAgentsStatus('loading')
    setAgentsMessage('Creating agent')
    try {
      const created = await createAgent({
        name,
        description,
        memoryProvider: agentForm.memoryProvider,
        cacheProvider: agentForm.cacheProvider,
        ragProvider: agentForm.ragProvider,
        enabledTools: agentForm.enabledTools,
        enabledSkills: agentForm.enabledSkills,
      })
      const nextAgents = await listAgents()
      setAgents(nextAgents)
      setAgentForm(DEFAULT_AGENT_FORM)
      setForm((current) => ({ ...current, agent: created.name }))
      setSelectedAgentId(created.id)
      await refreshDocuments(created.id)
      setAgentsStatus('ready')
      setAgentsMessage(`Created ${created.name}`)
    } catch (error) {
      setAgentsStatus('error')
      setAgentsMessage(handleRequestError(error, 'Failed to create agent'))
    }
  }

  function selectAgent(agent: AgentRecord) {
    setSelectedAgentId(agent.id)
    setForm((current) => ({ ...current, agent: agent.name }))
    void refreshDocuments(agent.id)
  }

  async function handleGenerateAgent() {
    if (!selectedAgentId) return

    setBuilderMessage('Generating project')
    try {
      const generated = await generateAgentProject(selectedAgentId)
      await refreshAgents()
      setBuilderMessage(`Generated ${generated.files.length} files`)
    } catch (error) {
      setCatalogStatus('error')
      setBuilderMessage(handleRequestError(error, 'Failed to generate project'))
    }
  }

  async function refreshDocuments(agentId = selectedAgentId) {
    if (!agentId) return

    setKnowledgeStatus('loading')
    setKnowledgeMessage('Loading documents')
    try {
      const nextDocuments = await listDocuments(agentId)
      setDocuments(nextDocuments)
      setKnowledgeStatus('idle')
      setKnowledgeMessage(`${nextDocuments.length} documents registered`)
    } catch (error) {
      setKnowledgeStatus('error')
      setKnowledgeMessage(handleRequestError(error, 'Failed to load documents'))
    }
  }

  async function handleCreateDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedAgentId) {
      setKnowledgeStatus('error')
      setKnowledgeMessage('Select an agent before registering documents.')
      return
    }

    const filename = documentForm.filename.trim()
    const content = documentForm.content.trim()
    const collection = documentForm.collection.trim()
    if (!filename || !content) {
      setKnowledgeStatus('error')
      setKnowledgeMessage('Filename and content are required.')
      return
    }

    setKnowledgeStatus('loading')
    setKnowledgeMessage('Registering document')
    try {
      await createDocument(selectedAgentId, { filename, content, collection })
      setDocumentForm(DEFAULT_DOCUMENT_FORM)
      await refreshDocuments(selectedAgentId)
    } catch (error) {
      setKnowledgeStatus('error')
      setKnowledgeMessage(handleRequestError(error, 'Failed to register document'))
    }
  }

  async function handleIndexDocument(documentId: number) {
    if (!selectedAgentId) return

    setKnowledgeStatus('loading')
    setKnowledgeMessage('Indexing document')
    try {
      const indexed = await indexDocument(selectedAgentId, documentId)
      setDocuments((current) => current.map((document) => (
        document.id === indexed.id ? indexed : document
      )))
      setKnowledgeStatus('idle')
      setKnowledgeMessage(`Indexed ${indexed.filename}`)
    } catch (error) {
      setKnowledgeStatus('error')
      setKnowledgeMessage(handleRequestError(error, 'Failed to index document'))
    }
  }

  function updateAgentForm<K extends keyof AgentFormState>(
    key: K,
    value: AgentFormState[K],
  ) {
    setAgentForm((current) => ({ ...current, [key]: value }))
  }

  function toggleAgentFormList(key: 'enabledTools' | 'enabledSkills', value: string) {
    setAgentForm((current) => {
      const values = current[key]
      const nextValues = values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value]
      return { ...current, [key]: nextValues }
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'running') return

    const goal = form.goal.trim()
    const agent = form.agent.trim()
    const tools = form.tools.split(',').map((tool) => tool.trim()).filter(Boolean)

    if (!goal || (!selectedAgentId && !agent)) {
      setStatus('error')
      setEvents([
        {
          id: eventIdRef.current++,
          event: 'agent.error',
          message: selectedAgentId ? 'Run input is required.' : 'Agent name and goal are required.',
          status: 'error',
          receivedAt: new Date().toLocaleTimeString(),
        },
      ])
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('running')
    setEvents([])
    setSummary({})

    try {
      const streamRequest = selectedAgentId
        ? { agentId: selectedAgentId, input: goal }
        : { agent, goal, tools }

      await streamAgentRun(streamRequest, {
        signal: controller.signal,
        onEvent: (parsed) => {
          const nextEvent: TimelineEvent = {
            id: eventIdRef.current++,
            event: parsed.event,
            receivedAt: new Date().toLocaleTimeString(),
            ...parsed.data,
          }

          setEvents((current) => [...current, nextEvent])
          setSummary((current) => ({ ...current, ...parsed.data }))

          if (
            parsed.event === 'agent.run.completed'
            || parsed.event === 'agent.done'
            || parsed.data.status === 'done'
          ) {
            setStatus('done')
          } else if (parsed.event === 'agent.error' || parsed.data.status === 'error') {
            setStatus('error')
          }
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus('error')
        setEvents((current) => [
          ...current,
          {
            id: eventIdRef.current++,
            event: 'agent.error',
            message: handleRequestError(error, 'Stream failed.'),
            status: 'error',
            receivedAt: new Date().toLocaleTimeString(),
          },
        ])
      }
    } finally {
      abortRef.current = null
      setStatus((current) => (current === 'running' ? 'idle' : current))
    }
  }

  function stopRun() {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus('idle')
  }

  if (authMode !== 'ready') {
    return (
      <main className="workspace auth-workspace">
        <form className="panel auth-panel" onSubmit={handleAuthSubmit}>
          <div className="panel-heading">
            <p className="product">Primalthrum</p>
            <h1>{authMode === 'setup' ? 'Create Admin' : 'Admin Login'}</h1>
            <p>{authMessage}</p>
          </div>

          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              disabled={authMode === 'checking'}
              onChange={(event) => setAuthForm((current) => ({
                ...current,
                email: event.target.value,
              }))}
              type="email"
              value={authForm.email}
            />
          </label>

          <label>
            <span>Password</span>
            <input
              autoComplete={authMode === 'setup' ? 'new-password' : 'current-password'}
              disabled={authMode === 'checking'}
              minLength={12}
              onChange={(event) => setAuthForm((current) => ({
                ...current,
                password: event.target.value,
              }))}
              type="password"
              value={authForm.password}
            />
          </label>

          <button className="primary" disabled={authMode === 'checking'} type="submit">
            {authMode === 'setup' ? 'Create Admin' : 'Sign In'}
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="product">Primalthrum</p>
          <h1>Agent R&D Console</h1>
        </div>
        <div className="topbar-actions">
          <div className="user-chip">{authUser?.email}</div>
          <div className={`status ${status}`}>
            <span />
            {statusLabel(status)}
          </div>
          <button className="secondary compact" onClick={() => void handleLogout()} type="button">
            Sign Out
          </button>
        </div>
      </header>

      <section className="management-shell">
        <section className="panel agents-panel">
          <div className="panel-heading inline">
            <div>
              <h2>Agents</h2>
              <p>{agentsMessage}</p>
            </div>
            <button className="secondary compact" type="button" onClick={refreshAgents}>
              Refresh
            </button>
          </div>

          <div className="agent-list" aria-busy={agentsStatus === 'loading'}>
            {agents.length === 0 ? (
              <div className="inline-empty">No agents registered</div>
            ) : (
              agents.map((agent) => (
                <button
                  className={agent.id === selectedAgentId ? 'agent-item selected' : 'agent-item'}
                  key={agent.id}
                  onClick={() => selectAgent(agent)}
                  type="button"
                >
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.slug}</small>
                  </span>
                  <em>{agent.status}</em>
                </button>
              ))
            )}
          </div>
        </section>

        <form className="panel create-agent-panel" onSubmit={handleCreateAgent}>
          <div className="panel-heading">
            <h2>Agent Builder</h2>
            <p>{builderMessage}</p>
          </div>

          <label>
            <span>Name</span>
            <input
              value={agentForm.name}
              onChange={(event) => updateAgentForm('name', event.target.value)}
              placeholder="Research Agent"
            />
          </label>

          <label>
            <span>Description</span>
            <input
              value={agentForm.description}
              onChange={(event) => updateAgentForm('description', event.target.value)}
              placeholder="What this agent is responsible for"
            />
          </label>

          <div className="builder-grid">
            <label>
              <span>Memory</span>
              <select
                value={agentForm.memoryProvider}
                onChange={(event) => updateAgentForm('memoryProvider', event.target.value)}
              >
                {(providers?.memory ?? []).map((provider) => (
                  <option
                    disabled={provider.status !== 'available'}
                    key={provider.name}
                    value={provider.name}
                  >
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Cache</span>
              <select
                value={agentForm.cacheProvider}
                onChange={(event) => updateAgentForm('cacheProvider', event.target.value)}
              >
                {(providers?.cache ?? []).map((provider) => (
                  <option
                    disabled={provider.status !== 'available'}
                    key={provider.name}
                    value={provider.name}
                  >
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>RAG</span>
              <select
                value={agentForm.ragProvider}
                onChange={(event) => updateAgentForm('ragProvider', event.target.value)}
              >
                {(providers?.rag ?? []).map((provider) => (
                  <option
                    disabled={provider.status !== 'available'}
                    key={provider.name}
                    value={provider.name}
                  >
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="toggle-group">
            <legend>Tools</legend>
            {toolsCatalog.map((tool) => (
              <label className="toggle-row" key={tool.name}>
                <input
                  checked={agentForm.enabledTools.includes(tool.name)}
                  disabled={tool.status !== 'available'}
                  onChange={() => toggleAgentFormList('enabledTools', tool.name)}
                  type="checkbox"
                />
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.permissions.join(', ')}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="toggle-group">
            <legend>Skills</legend>
            {skillsCatalog.map((skill) => (
              <label className="toggle-row" key={skill.name}>
                <input
                  checked={agentForm.enabledSkills.includes(skill.name)}
                  disabled={skill.status !== 'available'}
                  onChange={() => toggleAgentFormList('enabledSkills', skill.name)}
                  type="checkbox"
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.version}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="builder-actions">
            <button
              className="primary"
              type="submit"
              disabled={agentsStatus === 'loading' || catalogStatus === 'loading'}
            >
              Create
            </button>
            <button
              className="secondary"
              disabled={!selectedAgentId}
              onClick={handleGenerateAgent}
              type="button"
            >
              Generate
            </button>
          </div>
        </form>
      </section>

      <section className="security-shell">
        <section className="panel security-panel">
          <div className="panel-heading inline">
            <div>
              <h2>Security Settings</h2>
              <p>{securityMessage}</p>
            </div>
            <button
              className="secondary compact"
              disabled={securityStatus === 'loading'}
              onClick={() => void refreshSecuritySettings()}
              type="button"
            >
              Refresh
            </button>
          </div>

          <div className="provider-config-list">
            {providerConfigs.length === 0 ? (
              <div className="inline-empty">No provider configs saved</div>
            ) : (
              providerConfigs.map((config) => (
                <article className="provider-config-item" key={config.id}>
                  <div>
                    <strong>{config.name}</strong>
                    <small>{config.type}</small>
                    <code>{compactSecretRef(config.secretRef)}</code>
                  </div>
                  <div className="provider-config-actions">
                    <em>Plaintext hidden</em>
                    <button
                      className="secondary compact"
                      onClick={() => editProviderConfig(config)}
                      type="button"
                    >
                      Edit
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>

          <div className={selectedDangerousTools.length > 0 ? 'danger-warning active' : 'danger-warning'}>
            <strong>Dangerous tools</strong>
            <span>
              {dangerousTools.length === 0
                ? 'No dangerous tools are available in this workspace.'
                : selectedDangerousTools.length > 0
                  ? `${selectedDangerousTools.join(', ')} selected. Dangerous tools require explicit server policy.`
                  : `${dangerousTools.length} dangerous tools available, none selected.`}
            </span>
          </div>
        </section>

        <form className="panel provider-form-panel" onSubmit={handleSaveProviderConfig}>
          <div className="panel-heading">
            <h2>Provider Config</h2>
            <p>{providerConfigForm.id ? 'Rotate secret by entering a new value' : 'Secret is stored as a reference'}</p>
          </div>

          <div className="builder-grid">
            <label>
              <span>Name</span>
              <input
                value={providerConfigForm.name}
                onChange={(event) => updateProviderConfigForm('name', event.target.value)}
                placeholder="openai-production"
              />
            </label>

            <label>
              <span>Type</span>
              <select
                value={providerConfigForm.type}
                onChange={(event) => updateProviderConfigForm('type', event.target.value)}
              >
                <option value="llm">llm</option>
                <option value="embedding">embedding</option>
                <option value="memory">memory</option>
                <option value="cache">cache</option>
                <option value="rag">rag</option>
              </select>
            </label>
          </div>

          <div className="builder-grid">
            <label>
              <span>Provider</span>
              <input
                value={providerConfigForm.provider}
                onChange={(event) => updateProviderConfigForm('provider', event.target.value)}
                placeholder="openai"
              />
            </label>

            <label>
              <span>Model</span>
              <input
                value={providerConfigForm.model}
                onChange={(event) => updateProviderConfigForm('model', event.target.value)}
                placeholder="gpt-5-mini"
              />
            </label>
          </div>

          <label>
            <span>Secret</span>
            <input
              autoComplete="off"
              value={providerConfigForm.secret}
              onChange={(event) => updateProviderConfigForm('secret', event.target.value)}
              placeholder={providerConfigForm.id ? 'Leave blank to keep current reference' : 'Provider API key'}
              type="password"
            />
          </label>

          <div className="builder-actions">
            <button className="primary" disabled={securityStatus === 'loading'} type="submit">
              {providerConfigForm.id ? 'Update' : 'Save'}
            </button>
            <button
              className="secondary"
              onClick={() => setProviderConfigForm(DEFAULT_PROVIDER_CONFIG_FORM)}
              type="button"
            >
              Clear
            </button>
          </div>
        </form>
      </section>

      <section className="knowledge-shell">
        <section className="panel knowledge-panel">
          <div className="panel-heading inline">
            <div>
              <h2>Knowledge</h2>
              <p>{knowledgeMessage}</p>
            </div>
            <button
              className="secondary compact"
              disabled={!selectedAgentId || knowledgeStatus === 'loading'}
              onClick={() => void refreshDocuments()}
              type="button"
            >
              Refresh
            </button>
          </div>

          <div className="document-list">
            {documents.length === 0 ? (
              <div className="inline-empty">No documents registered</div>
            ) : (
              documents.map((document) => (
                <article className="document-item" key={document.id}>
                  <div>
                    <strong>{document.filename}</strong>
                    <small>{document.collection}</small>
                    <code>{document.hash.slice(0, 12)}</code>
                  </div>
                  <div className="document-actions">
                    <em>{document.indexStatus}</em>
                    <button
                      className="secondary compact"
                      disabled={knowledgeStatus === 'loading'}
                      onClick={() => void handleIndexDocument(document.id)}
                      type="button"
                    >
                      Index
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <form className="panel document-form-panel" onSubmit={handleCreateDocument}>
          <div className="panel-heading">
            <h2>Register Document</h2>
            <p>{selectedAgent?.name ?? 'Choose an agent first'}</p>
          </div>

          <div className="builder-grid">
            <label>
              <span>Filename</span>
              <input
                value={documentForm.filename}
                onChange={(event) => setDocumentForm((current) => ({
                  ...current,
                  filename: event.target.value,
                }))}
                placeholder="guide.md"
              />
            </label>

            <label>
              <span>Collection</span>
              <input
                value={documentForm.collection}
                onChange={(event) => setDocumentForm((current) => ({
                  ...current,
                  collection: event.target.value,
                }))}
                placeholder="research"
              />
            </label>
          </div>

          <label>
            <span>Content</span>
            <textarea
              value={documentForm.content}
              onChange={(event) => setDocumentForm((current) => ({
                ...current,
                content: event.target.value,
              }))}
              rows={4}
              placeholder="Paste knowledge text for indexing."
            />
          </label>

          <button
            className="primary"
            disabled={!selectedAgentId || knowledgeStatus === 'loading'}
            type="submit"
          >
            Register
          </button>
        </form>
      </section>

      <section className="shell">
        <form className="panel control-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <h2>Run Configuration</h2>
            <p>{latestMessage}</p>
          </div>

          <div className="run-target">
            <span>Selected Agent</span>
            <strong>{selectedAgent?.name ?? 'Legacy direct payload'}</strong>
          </div>

          <label>
            <span>Agent</span>
            <input
              value={form.agent}
              onChange={(event) => setForm((current) => ({ ...current, agent: event.target.value }))}
              placeholder="ResearchAgent"
              disabled={Boolean(selectedAgent)}
            />
          </label>

          <label>
            <span>Goal</span>
            <textarea
              value={form.goal}
              onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))}
              rows={6}
              placeholder="Describe the agent you want to initialize."
            />
          </label>

          <label>
            <span>Tools</span>
            <input
              value={form.tools}
              onChange={(event) => setForm((current) => ({ ...current, tools: event.target.value }))}
              placeholder="planner, memory, executor"
            />
          </label>

          <div className="actions">
            <button className="primary" type="submit" disabled={status === 'running'}>
              {status === 'running' ? 'Streaming' : 'Start Stream'}
            </button>
            <button className="secondary" type="button" onClick={stopRun} disabled={status !== 'running'}>
              Stop
            </button>
          </div>
        </form>

        <section className="panel timeline-panel" aria-live="polite">
          <div className="panel-heading inline">
            <div>
              <h2>Stream Timeline</h2>
              <p>{hasOutput ? `${events.length} events received` : 'No stream events yet'}</p>
            </div>
            <code>{selectedAgent ? 'POST /api/stream agentId' : 'POST /api/stream'}</code>
          </div>

          <div className="timeline">
            {!hasOutput && (
              <div className="empty-state">
                <strong>Waiting for a run</strong>
                <span>Submit the configuration to watch LangGraph node updates arrive as SSE events.</span>
              </div>
            )}

            {events.map((item) => (
              <article className={`event-row ${item.status === 'error' ? 'error' : ''}`} key={item.id}>
                <div className="event-marker" />
                <div>
                  <div className="event-meta">
                    <span>{item.event}</span>
                    <span>{item.node ?? 'stream'}</span>
                    <time>{item.receivedAt}</time>
                  </div>
                  <p>{item.message ?? 'Node completed'}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="panel summary-panel">
          <div className="panel-heading">
            <h2>Run Artifacts</h2>
            <p>{summary.agent ?? form.agent}</p>
          </div>

          <SummaryList title="Tools" items={visibleArtifacts.tools} />
          <SummaryList title="Plan" items={visibleArtifacts.plan} />
          <SummaryList title="Artifacts" items={visibleArtifacts.artifacts} />
          <SummaryList title="Checks" items={visibleArtifacts.checks} />
        </aside>
      </section>
    </main>
  )
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="summary-group">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">Pending</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
