import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    console.error('[ErrorBoundary] getDerivedStateFromError:', error)
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] componentDidCatch:', error, errorInfo)
    this.setState({ errorInfo })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      const errorStack = this.state.error?.stack || ''
      const componentStack = this.state.errorInfo?.componentStack || ''
      const shortStack = errorStack.split('\n').slice(0, 5).join('\n')

      return (
        <div style={{
          padding: '40px',
          maxWidth: '700px',
          margin: '80px auto',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
          <div style={{
            padding: '24px',
            borderRadius: '12px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
          }}>
            <h2 style={{ margin: '0 0 12px', fontSize: '18px', color: '#dc2626' }}>
              应用遇到了一个错误
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: '14px', color: '#7f1d1d' }}>
              页面渲染时发生异常，这可能是导致白屏的原因。请将以下错误信息反馈给开发者。
            </p>
            <div style={{
              padding: '12px',
              borderRadius: '8px',
              background: '#fff',
              border: '1px solid #e5e7eb',
              marginBottom: '16px',
              maxHeight: '200px',
              overflow: 'auto',
            }}>
              <pre style={{ margin: 0, fontSize: '12px', color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {this.state.error?.message || 'Unknown error'}{'\n\n'}
                {shortStack}{'\n\n'}
                Component stack:{'\n'}
                {componentStack}
              </pre>
            </div>
            <button
              onClick={this.handleReload}
              style={{
                padding: '8px 24px',
                fontSize: '14px',
                fontWeight: 600,
                color: '#fff',
                background: '#2563eb',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              重新加载应用
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
