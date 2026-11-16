import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { log } from '../../state/store';

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps a failing panel from taking down the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log('error', `${this.props.name} failed to render: ${error.message}`, info.componentStack?.split('\n').slice(0, 3).join(' ').trim());
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <AlertTriangle />
        <h3>{this.props.name} could not be displayed</h3>
        <p className="mono">{this.state.error.message}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
