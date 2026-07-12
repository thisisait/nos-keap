import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { Tabs } from '~/components/Tabs';
import {
  sendCallApi,
  sendCheckPairing,
  sendClearState,
  sendGetState,
  sendOpenTab,
  sendStartPairing,
} from '~/utils/api';

import { ExternalLink, LogIn, LogOut, RefreshCw, Save, Search, Settings, X } from 'lucide-react';

type ExtensionState = import('~/utils/storage').ExtensionState;

type PageContext = {
  url: string;
  title: string;
  selection: string;
  excerpt: string;
};

function getPageContext(): PageContext {
  return {
    url: location.href,
    title: document.title || location.href,
    selection: (document.getSelection()?.toString() || '').trim(),
    excerpt: (document.body?.innerText || '').slice(0, 2000).trim(),
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err) || 'Unknown error';
}

export type KeapResult = Record<string, unknown>;
export type SearchResult = {
  items?: KeapResult[];
  onDomain?: KeapResult[];
  legs?: string[];
};

export type PairingResponse = {
  pairingId: string;
  userCode: string;
  verificationPath: string;
  expiresAt: number;
  intervalSeconds: number;
  deviceSecret: string;
  instanceUrl: string;
};

export default function App() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('context');
  const [state, setState] = useState<ExtensionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState<PageContext>(getPageContext());
  const [results, setResults] = useState<SearchResult | null>(null);
  const [query, setQuery] = useState('');
  const [capture, setCapture] = useState({ title: '', text: '', tags: '' });
  const [pairForm, setPairForm] = useState({ instanceUrl: '', clientName: 'KEAP Companion' });
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [pollId, setPollId] = useState<number | null>(null);

  const tabs = useMemo(
    () => [
      { id: 'context', label: 'Context' },
      { id: 'capture', label: 'Capture' },
      { id: 'search', label: 'Search' },
      { id: 'objects', label: 'Objects' },
      { id: 'taxonomy', label: 'Taxonomy' },
      { id: 'settings', label: 'Settings' },
    ],
    [],
  );

  const refreshState = useCallback(async () => {
    try {
      const next = await sendGetState();
      setState(next);
      setPairForm((prev) => ({ ...prev, instanceUrl: next.instanceUrl || prev.instanceUrl || '' }));
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  const handleResolve = useCallback(async () => {
    if (!state?.token) {
      setError('Not paired with a KEAP instance.');
      setTab('settings');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = (await sendCallApi('POST', '/context/resolve', {
        url: page.url,
        title: page.title,
        selection: page.selection,
        excerpt: page.excerpt,
      })) as SearchResult;
      setResults(data);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [state, page]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    const listener = (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      setPage(getPageContext());
      switch (m.type) {
        case 'TOGGLE':
          setOpen((o) => !o);
          break;
        case 'ACTION':
          setOpen(true);
          setTab('context');
          break;
        case 'SEARCH':
          setOpen(true);
          setTab('search');
          setQuery(String(m.query || ''));
          break;
        case 'CAPTURE_PAGE': {
          const ctx = getPageContext();
          setOpen(true);
          setTab('capture');
          setCapture({ title: ctx.title, text: ctx.excerpt, tags: '' });
          break;
        }
        case 'CAPTURE_SELECTION': {
          const ctx = getPageContext();
          setOpen(true);
          setTab('capture');
          setCapture({ title: ctx.title, text: String(m.query || ''), tags: '' });
          break;
        }
        case 'CAPTURE_LINK': {
          setOpen(true);
          setTab('capture');
          setCapture({
            title: String(m.linkText || m.url || ''),
            text: String(m.url || ''),
            tags: '',
          });
          break;
        }
        default:
          break;
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (open) {
      refreshState();
      if (tab === 'context' && state?.token && !results) {
        handleResolve();
      }
    }
  }, [open, tab, state?.token, results, handleResolve, refreshState]);

  useEffect(() => {
    return () => {
      if (pollId) window.clearInterval(pollId);
    };
  }, [pollId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state?.token) {
      setError('Not paired with a KEAP instance.');
      setTab('settings');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = (await sendCallApi('POST', '/context/resolve', {
        url: page.url,
        title: query,
        excerpt: '',
      })) as SearchResult;
      setResults(data);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCapture = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state?.token) {
      setError('Not paired with a KEAP instance.');
      setTab('settings');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const domain = (() => {
        try {
          return new URL(page.url).hostname;
        } catch {
          return undefined;
        }
      })();
      await sendCallApi('POST', '/captures', {
        title: capture.title,
        text: capture.text,
        url: page.url,
        domain,
        tags: capture.tags
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setMessage('Capture saved');
      setCapture({ title: '', text: '', tags: '' });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  const startPairingFlow = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const data = (await sendStartPairing(pairForm.instanceUrl, pairForm.clientName)) as PairingResponse;
      setPairing(data);
      await refreshState();
      setMessage(`Pairing started. Code: ${data.userCode}`);
      if (pollId) window.clearInterval(pollId);
      const id = window.setInterval(async () => {
        try {
          await sendCheckPairing(data.instanceUrl, data.pairingId, data.deviceSecret);
          window.clearInterval(id);
          setPollId(null);
          setPairing(null);
          await refreshState();
          setMessage('Paired successfully');
        } catch (err) {
          const msg = formatError(err);
          if (msg.includes('428') || msg.toLowerCase().includes('pending')) {
            return;
          }
          window.clearInterval(id);
          setPollId(null);
          setError(msg);
        }
      }, (data.intervalSeconds || 3) * 1000);
      setPollId(id);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  const manualCheckPairing = async () => {
    const p = state?.pendingPairing || pairing;
    if (!p) return;
    setLoading(true);
    setError(null);
    try {
      await sendCheckPairing(p.instanceUrl, p.pairingId, p.deviceSecret);
      if (pollId) window.clearInterval(pollId);
      setPollId(null);
      setPairing(null);
      await refreshState();
      setMessage('Paired successfully');
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleUnpair = async () => {
    setLoading(true);
    try {
      await sendClearState();
      setPairing(null);
      if (pollId) window.clearInterval(pollId);
      setPollId(null);
      await refreshState();
      setMessage('Unpaired');
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  const openKeap = async (path = '') => {
    if (!state?.instanceUrl) return;
    const baseUrl = state.instanceUrl.replace(/\/$/, '');
    const url = path.startsWith('http')
      ? path
      : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    await sendOpenTab(url);
  };

  if (!open) return null;

  return (
    <div
      id="keap-panel-root"
      className="fixed bottom-0 left-0 z-[2147483647] flex h-[320px] w-screen flex-col border-t border-slate-200 bg-white text-sm text-slate-900 shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800">KEAP Companion</span>
          {state?.token && state.user && (
            <span className="text-xs text-slate-500">
              {state.user.name || state.user.username}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('settings')}
            className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="flex-1 overflow-auto p-3">
        {error && (
          <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
            {message}
          </div>
        )}
        {loading && <div className="text-xs text-slate-500">Loading...</div>}

        {tab === 'context' && (
          <ContextTab
            page={page}
            results={results}
            loading={loading}
            onResolve={handleResolve}
            state={state}
            onOpen={openKeap}
          />
        )}
        {tab === 'capture' && (
          <CaptureTab
            capture={capture}
            setCapture={setCapture}
            page={page}
            onSubmit={handleCapture}
            loading={loading}
          />
        )}
        {tab === 'search' && (
          <SearchTab
            query={query}
            setQuery={setQuery}
            onSubmit={handleSearch}
            results={results}
            loading={loading}
            onOpen={openKeap}
          />
        )}
        {tab === 'objects' && <ObjectsTab state={state} />}
        {tab === 'taxonomy' && <TaxonomyTab state={state} />}
        {tab === 'settings' && (
          <SettingsTab
            state={state}
            pairForm={pairForm}
            setPairForm={setPairForm}
            pairing={pairing}
            onStartPairing={startPairingFlow}
            onCheckPairing={manualCheckPairing}
            onUnpair={handleUnpair}
            onOpen={openKeap}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}

function ContextTab({
  page,
  results,
  loading,
  onResolve,
  state,
  onOpen,
}: {
  page: PageContext;
  results: SearchResult | null;
  loading: boolean;
  onResolve: () => void;
  state: ExtensionState | null;
  onOpen: (path: string) => void;
}) {
  const items = Array.isArray(results?.items) ? results.items : [];
  const onDomain = Array.isArray(results?.onDomain) ? results.onDomain : [];

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        <div className="truncate font-medium text-slate-700">{page.title}</div>
        <div className="truncate">{page.url}</div>
        {page.selection && (
          <div className="mt-1 rounded bg-slate-100 p-1 text-slate-700">
            <span className="font-semibold">Selection:</span> {page.selection.slice(0, 200)}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onResolve}
          disabled={loading || !state?.token}
          className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Search className="h-3 w-3" /> Resolve context
        </button>
        {!state?.token && (
          <span className="self-center text-xs text-slate-500">Pair KEAP first</span>
        )}
      </div>

      {items.length > 0 && (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-semibold text-slate-700">{items.length} result(s)</div>
          {items.map((item, idx) => (
            <ResultItem key={idx} item={item} onOpen={onOpen} />
          ))}
          {onDomain.length > 0 && (
            <div className="mt-2">
              <div className="text-xs font-semibold text-slate-700">On this domain</div>
              {onDomain.map((item, idx) => (
                <ResultItem key={`domain-${idx}`} item={item} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultItem({ item, onOpen }: { item: KeapResult; onOpen: (url: string) => void }) {
  const kind = String(item.kind || 'unknown');
  const title = String(item.title || item.name || 'Untitled');
  const description = String(item.description || item.brief || '');
  const score = typeof item.score === 'number' ? `${Math.round(item.score * 100)}%` : null;
  const url = typeof item.url === 'string' ? item.url : undefined;

  const icon =
    kind === 'taxonomy' ? '📁 ' : kind === 'capture' ? '🔗 ' : kind === 'object' ? '📄 ' : '📝 ';

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-800">
          {icon}
          {title}
        </span>
        <span className="whitespace-nowrap rounded bg-slate-200 px-1 text-[10px] uppercase text-slate-600">
          {kind}
        </span>
      </div>
      {description && <div className="mt-1 line-clamp-2 text-slate-600">{description}</div>}
      {score && <div className="mt-1 text-[10px] text-slate-400">score {score}</div>}
      {url && (
        <button
          type="button"
          onClick={() => onOpen(url)}
          className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </button>
      )}
    </div>
  );
}

function CaptureTab({
  capture,
  setCapture,
  page,
  onSubmit,
  loading,
}: {
  capture: { title: string; text: string; tags: string };
  setCapture: (c: { title: string; text: string; tags: string }) => void;
  page: PageContext;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-slate-700">Title</label>
        <input
          type="text"
          value={capture.title}
          onChange={(e) => setCapture({ ...capture, title: e.target.value })}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
          placeholder={page.title}
          required
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-700">Text</label>
        <textarea
          value={capture.text}
          onChange={(e) => setCapture({ ...capture, text: e.target.value })}
          className="h-20 w-full resize-none rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
          placeholder="Text or selection"
          required
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-700">Tags</label>
        <input
          type="text"
          value={capture.tags}
          onChange={(e) => setCapture({ ...capture, tags: e.target.value })}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
          placeholder="comma, separated"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        <Save className="h-3 w-3" /> Save capture
      </button>
    </form>
  );
}

function SearchTab({
  query,
  setQuery,
  onSubmit,
  results,
  loading,
  onOpen,
}: {
  query: string;
  setQuery: (q: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  results: SearchResult | null;
  loading: boolean;
  onOpen: (url: string) => void;
}) {
  const items = Array.isArray(results?.items) ? results.items : [];
  return (
    <div className="space-y-2">
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
          placeholder="Search KEAP..."
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Search className="h-3 w-3" />
        </button>
      </form>
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map((item, idx) => (
            <ResultItem key={idx} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectsTab({ state }: { state: ExtensionState | null }) {
  const [objects, setObjects] = useState<KeapResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [tabError, setTabError] = useState<string | null>(null);

  useEffect(() => {
    if (!state?.token) return;
    setLoading(true);
    sendCallApi('GET', '/objects?limit=20')
      .then((data) => {
        const list = data && typeof data === 'object' && 'items' in data ? (data as { items: unknown[] }).items : [];
        setObjects(list.map((obj: unknown) => obj as KeapResult));
      })
      .catch((err) => setTabError(formatError(err)))
      .finally(() => setLoading(false));
  }, [state?.token]);

  if (!state?.token) return <div className="text-xs text-slate-500">Pair KEAP to view objects.</div>;
  if (loading) return <div className="text-xs text-slate-500">Loading objects...</div>;
  if (tabError) return <div className="text-xs text-red-600">{tabError}</div>;

  return (
    <div className="space-y-1">
      {objects?.map((obj: KeapResult, idx) => (
        <div key={String(obj.id ?? idx)} className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-800">{String(obj.title || obj.id || 'Untitled')}</span>
            <span className="rounded bg-slate-200 px-1 text-[10px] uppercase text-slate-600">
              {String(obj.type || 'object')}
            </span>
          </div>
          {obj.description && typeof obj.description === 'string' && (
            <div className="mt-1 line-clamp-2 text-slate-600">{obj.description}</div>
          )}
        </div>
      ))}
      {!objects?.length && <div className="text-xs text-slate-500">No objects found.</div>}
    </div>
  );
}

function TaxonomyTab({ state }: { state: ExtensionState | null }) {
  const [nodes, setNodes] = useState<KeapResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [tabError, setTabError] = useState<string | null>(null);

  useEffect(() => {
    if (!state?.token) return;
    setLoading(true);
    sendCallApi('GET', '/taxonomy/tree')
      .then((data) => {
        setNodes(Array.isArray(data) ? (data as unknown[]).map((n) => n as KeapResult) : []);
      })
      .catch((err) => setTabError(formatError(err)))
      .finally(() => setLoading(false));
  }, [state?.token]);

  if (!state?.token) return <div className="text-xs text-slate-500">Pair KEAP to view taxonomy.</div>;
  if (loading) return <div className="text-xs text-slate-500">Loading taxonomy...</div>;
  if (tabError) return <div className="text-xs text-red-600">{tabError}</div>;

  return (
    <div className="space-y-1">
      {nodes?.map((node: KeapResult, idx) => (
        <div key={String(node.id ?? idx)} className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <div className="font-medium text-slate-800">{String(node.name || 'Untitled')}</div>
          {node.description && typeof node.description === 'string' && (
            <div className="line-clamp-2 text-slate-600">{node.description}</div>
          )}
          <div className="mt-1 text-[10px] text-slate-400">{String(node.path ?? '')}</div>
        </div>
      ))}
      {!nodes?.length && <div className="text-xs text-slate-500">No taxonomy nodes found.</div>}
    </div>
  );
}

function SettingsTab({
  state,
  pairForm,
  setPairForm,
  pairing,
  onStartPairing,
  onCheckPairing,
  onUnpair,
  onOpen,
  loading,
}: {
  state: ExtensionState | null;
  pairForm: { instanceUrl: string; clientName: string };
  setPairForm: (f: { instanceUrl: string; clientName: string }) => void;
  pairing: PairingResponse | null;
  onStartPairing: (e: React.FormEvent) => void;
  onCheckPairing: () => void;
  onUnpair: () => void;
  onOpen: (path: string) => void;
  loading: boolean;
}) {
  const pending = state?.pendingPairing || pairing;

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Connect to any KEAP instance to resolve context, capture pages and manage objects.
      </div>

      {state?.token && state?.user && (
        <div className="rounded border border-green-200 bg-green-50 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-green-800">
              <LogIn className="inline h-3 w-3" /> Paired as {state.user.name || state.user.username}
            </span>
            <button
              type="button"
              onClick={onUnpair}
              className="flex items-center gap-1 rounded bg-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-300"
            >
              <LogOut className="h-3 w-3" /> Unpair
            </button>
          </div>
          <div className="mt-1 text-slate-600">Instance: {state.instanceUrl}</div>
          <div className="text-slate-600">Scopes: {(state.scopes || []).join(', ')}</div>
          <button
            type="button"
            onClick={() => onOpen('')}
            className="mt-2 inline-flex items-center gap-1 text-blue-600 hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Open KEAP
          </button>
        </div>
      )}

      {pending && !state?.token && (
        <div className="rounded border border-blue-200 bg-blue-50 p-2 text-xs">
          <div className="font-medium text-blue-800">Pairing in progress</div>
          <div className="mt-1 text-slate-700">
            User code: <strong>{pending.userCode}</strong>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onOpen(pending.verificationPath)}
              className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
            >
              Open KEAP
            </button>
            <button
              type="button"
              onClick={onCheckPairing}
              disabled={loading}
              className="flex items-center gap-1 rounded bg-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-300 disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" /> Check approval
            </button>
          </div>
        </div>
      )}

      {!state?.token && (
        <form onSubmit={onStartPairing} className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-slate-700">Instance URL</label>
            <input
              type="text"
              value={pairForm.instanceUrl}
              onChange={(e) => setPairForm({ ...pairForm, instanceUrl: e.target.value })}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
              placeholder="https://keap.example.com or http://localhost:8080"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Client name</label>
            <input
              type="text"
              value={pairForm.clientName}
              onChange={(e) => setPairForm({ ...pairForm, clientName: e.target.value })}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <LogIn className="h-3 w-3" /> Start pairing
          </button>
        </form>
      )}

      <div className="text-[10px] text-slate-400">
        Tip: approve the pairing in the KEAP tab opened by the extension.
      </div>
    </div>
  );
}
