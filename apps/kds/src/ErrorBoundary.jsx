import { Component } from "react";

// Top-level error boundary. White-screen-of-death during a Friday-night rush
// is unacceptable — if React throws, show a "reconnecting…" screen and
// auto-reload after 5 s. The reload picks up any new bundle the SW cached.

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("KDS root error", error, info);
    this.timer = setTimeout(() => {
      window.location.reload();
    }, 5000);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="kds-error-screen" role="alert">
          <div className="kds-error-content">
            <div className="kds-error-icon">⚠️</div>
            <div className="kds-error-title">Kitchen Display reconnecting…</div>
            <div className="kds-error-subtitle">If this doesn't clear in 5 seconds, refresh the tablet.</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
