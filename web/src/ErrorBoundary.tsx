import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(JSON.stringify({
      level: 'error',
      message: 'frontend render failed',
      error: error.message,
      componentStack: info.componentStack,
    }))
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="workspace fatal-error" role="alert">
          <section className="panel fatal-error-panel">
            <div className="panel-heading">
              <p className="product">Primalthrum</p>
              <h1>Console unavailable</h1>
              <p>{this.state.error.message || 'A rendering error interrupted the console.'}</p>
            </div>
            <button
              className="primary"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload Console
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
