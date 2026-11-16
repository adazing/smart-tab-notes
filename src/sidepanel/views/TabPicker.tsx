/**
 * Which tabs a chat question may use, shown as tags above the input.
 *
 * The current tab is included by default. "+ Add tab" lists the other tabs
 * in this window. While the user types, POST /rank-tabs scores them and
 * suggested ones appear as one-click "+ title" buttons, but are only used
 * once the user clicks them. Ranking only sends tab titles and origin +
 * path: no page text is read until the question is sent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHAT_LIMITS, postRankTabs } from '../../shared/api';
import { sendToBackground } from '../../shared/messages';
import type { TabGroupRef, TabRef } from '../../shared/types';
import { urlForRanking } from '../chatRequest';

/** Wait this long after typing stops before ranking. */
const RANK_DELAY_MS = 600;
/** Don't rank until the question has this many characters. */
const RANK_MIN_CHARS = 12;
const RANK_MAX_TABS = 100;

export interface TabPickerState {
  /** Readable-or-not tabs in this window, in tab-strip order. */
  tabs: TabRef[];
  groups: TabGroupRef[];
  current: TabRef | null;
  includeCurrent: boolean;
  setIncludeCurrent: (value: boolean) => void;
  picked: ReadonlySet<number>;
  toggle: (tabId: number) => void;
  /** tabId -> score, for tabs /rank-tabs suggested. */
  suggested: ReadonlyMap<number, number>;
  /** The tab ids a question would use right now, current tab first. */
  chosenIds: number[];
  /** Re-read the tab list. */
  reload: () => void;
}

export function useTabPicker(current: TabRef | null, question: string): TabPickerState {
  const windowId = current?.windowId ?? null;
  const [tabs, setTabs] = useState<TabRef[]>([]);
  const [groups, setGroups] = useState<TabGroupRef[]>([]);
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [suggested, setSuggested] = useState<Map<number, number>>(new Map());
  const listRequest = useRef(0);

  const reload = useCallback(() => {
    const request = ++listRequest.current;
    void sendToBackground('tabs:list', {}).then((result) => {
      if (request !== listRequest.current || !result.ok) return;
      const inWindow = result.data.tabs.filter((tab) => tab.windowId === windowId);
      setTabs(inWindow);
      setGroups(result.data.groups.filter((group) => group.windowId === windowId));
      // Forget picks for tabs that have closed.
      const open = new Set(inWindow.map((tab) => tab.tabId));
      setPicked((old) => (([...old].every((id) => open.has(id))) ? old : new Set([...old].filter((id) => open.has(id)))));
    });
  }, [windowId]);

  // Reload when the active tab or its page changes (usePageState follows
  // tabs:changed), and whenever the picker is opened.
  useEffect(reload, [reload, current?.tabId, current?.url, current?.title]);

  const others = useMemo(
    () => tabs.filter((tab) => tab.tabId !== current?.tabId && tab.accessible),
    [tabs, current?.tabId],
  );

  // Rank the other tabs against the question as the user types.
  useEffect(() => {
    const text = question.trim();
    if (text.length < RANK_MIN_CHARS || others.length === 0) {
      setSuggested(new Map());
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const candidates = others.slice(0, RANK_MAX_TABS).map((tab) => ({
        tab_id: tab.tabId, title: tab.title.slice(0, 1_000), url: urlForRanking(tab.url), snippet: '',
      }));
      postRankTabs({ question: text.slice(0, 2_000), tabs: candidates }, controller.signal)
        .then((scores) => {
          setSuggested(new Map(scores.filter((s) => s.suggested).map((s) => [s.tab_id, s.score])));
        })
        // Suggestions are optional: no backend or key just means none.
        .catch(() => { if (!controller.signal.aborted) setSuggested(new Map()); });
    }, RANK_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [question, others]);

  const toggle = useCallback((tabId: number) => {
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  }, []);

  const currentUsable = !!current?.accessible;
  const chosenIds = useMemo(() => {
    const ids = includeCurrent && currentUsable && current ? [current.tabId] : [];
    for (const tab of tabs) if (picked.has(tab.tabId) && tab.tabId !== current?.tabId) ids.push(tab.tabId);
    return ids.slice(0, CHAT_LIMITS.tabs);
  }, [includeCurrent, currentUsable, current, tabs, picked]);

  return { tabs, groups, current, includeCurrent, setIncludeCurrent, picked, toggle, suggested, chosenIds, reload };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function TabPicker({ picker, disabled }: { picker: TabPickerState; disabled: boolean }): JSX.Element {
  const { tabs, current, includeCurrent, setIncludeCurrent, picked, toggle, suggested, chosenIds, reload } = picker;
  const [adding, setAdding] = useState(false);
  const label = (tab: TabRef): string => tab.title || hostOf(tab.url);
  const full = chosenIds.length >= CHAT_LIMITS.tabs;
  const chosen = new Set(chosenIds);
  const others = tabs
    .filter((tab) => tab.tabId !== current?.tabId && tab.accessible && !chosen.has(tab.tabId))
    .sort((a, b) => (suggested.get(b.tabId) ?? -1) - (suggested.get(a.tabId) ?? -1) || a.index - b.index);
  const suggestions = others.filter((tab) => suggested.has(tab.tabId) && tab.loaded);
  const currentUsable = !!current?.accessible;

  return (
    <div className="tabs-bar">
      <div className="tabs-bar__row" role="group" aria-label="Tabs this question uses">
        <span className="tabs-bar__label">Asking about</span>
        {current && currentUsable && includeCurrent && (
          <span className="tab-tag">
            <span className="tab-tag__title">{label(current)}</span>
            <span className="tab-tag__note">this tab</span>
            <button
              type="button"
              className="tab-tag__remove"
              aria-label={`Don't use ${label(current)}`}
              disabled={disabled}
              onClick={() => setIncludeCurrent(false)}
            >×</button>
          </span>
        )}
        {tabs.filter((tab) => picked.has(tab.tabId) && tab.tabId !== current?.tabId).map((tab) => (
          <span key={tab.tabId} className="tab-tag">
            <span className="tab-tag__title">{label(tab)}</span>
            <button
              type="button"
              className="tab-tag__remove"
              aria-label={`Don't use ${label(tab)}`}
              disabled={disabled}
              onClick={() => toggle(tab.tabId)}
            >×</button>
          </span>
        ))}
        {current && currentUsable && !includeCurrent && (
          <button type="button" className="tab-add" disabled={disabled || full} onClick={() => setIncludeCurrent(true)}>
            + This tab
          </button>
        )}
        <button
          type="button"
          className="tab-add"
          aria-expanded={adding}
          disabled={disabled}
          onClick={() => { if (!adding) reload(); setAdding(!adding); }}
        >
          + Add tab
        </button>
      </div>

      {suggestions.length > 0 && !full && (
        <div className="tabs-bar__row" role="group" aria-label="Suggested tabs">
          <span className="tabs-bar__label">Suggested</span>
          {suggestions.slice(0, 4).map((tab) => (
            <button
              key={tab.tabId}
              type="button"
              className="tab-add tab-add--suggested"
              disabled={disabled}
              title={tab.url}
              onClick={() => toggle(tab.tabId)}
            >
              + {label(tab)}
            </button>
          ))}
        </div>
      )}

      {adding && (
        <ul className="tab-menu" aria-label="Other tabs in this window">
          {others.length === 0 && <li className="muted">No other tabs to add in this window.</li>}
          {others.map((tab) => (
            <li key={tab.tabId}>
              <button
                type="button"
                className="tab-menu__item"
                disabled={disabled || full || !tab.loaded}
                title={tab.loaded ? tab.url : 'Not loaded yet: open this tab once, then add it'}
                onClick={() => { toggle(tab.tabId); setAdding(false); }}
              >
                <span className="tab-tag__title">{label(tab)}</span>
                {suggested.has(tab.tabId) && <span className="badge">Suggested</span>}
                {!tab.loaded && <span className="badge badge--muted">Not loaded</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!currentUsable && chosenIds.length === 0 && (
        <p className="muted tabs-bar__hint">This tab can't be read. Add a tab to ask about.</p>
      )}
      {full && <p className="muted tabs-bar__hint">Up to {CHAT_LIMITS.tabs} tabs per question.</p>}
    </div>
  );
}
