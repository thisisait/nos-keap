import { defineContentScript } from 'wxt/sandbox';
import { createShadowRootUi } from 'wxt/client';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

// eslint-disable-next-line react-refresh/only-export-components
export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  runAt: 'document_end',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'keap-panel',
      position: 'overlay',
      anchor: 'body',
      alignment: 'bottom-left',
      zIndex: 999999,
      isolateEvents: true,
      onMount(container, _shadow, shadowHost) {
        const app = document.createElement('div');
        app.id = 'keap-panel-root';
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(<App />);
        return { root, app, shadowHost };
      },
      onRemove(mounted) {
        mounted?.root?.unmount();
        mounted?.app?.remove();
      },
    });
    ui.mount();
  },
});
