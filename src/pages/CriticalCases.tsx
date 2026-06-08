import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Search, Users, UserCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { useLocation } from 'react-router-dom';
import CaseCard from '../components/CaseCard';
import ConnectionCard from '../components/ConnectionCard';
import NotesModal from '../components/NotesModal';
import UserDetailsModal from '../components/UserDetailsModal';
import DirectChatModal from '../components/DirectChatModal';
import CaseDetailsModal from '../components/CaseDetailsModal';
import { Case, AdvisorConnection } from '../types';
import { db } from '../lib/firebase';
import { collection, onSnapshot, getDoc, doc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  listenToCriticalCases,
  acceptAdvisorConnection,
  markCaseReviewed,
} from '../lib/advisorConnections';

// ── Backend alert processing (Part A) ─────────────────────────────────────────
// Module-level Set persists for the entire browser session tab so we never call
// the backend more than once per connectionId, even if the listener fires again.
const _processedSessionIds = new Set<string>();

const _API_BASE = import.meta.env.VITE_API_BASE_URL as string | undefined;

async function processConnectionAlert(
  connectionId: string,
  getToken: () => Promise<string>,
): Promise<void> {
  if (!_API_BASE) {
    console.warn('[CriticalCases] VITE_API_BASE_URL is not set — skipping backend alert processing');
    return;
  }
  if (_processedSessionIds.has(connectionId)) return;
  _processedSessionIds.add(connectionId);
  try {
    const token = await getToken();
    const res = await fetch(
      `${_API_BASE}/critical-alerts/process-advisor-connection/${connectionId}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.warn(`[CriticalCases] Backend returned ${res.status} for connection ${connectionId}`);
    }
  } catch (err) {
    console.error('[CriticalCases] Failed to process connection alert:', connectionId, err);
  }
}

function toDateString(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object' && 'seconds' in (value as object)) {
    try {
      const d = new Date((value as { seconds: number }).seconds * 1000);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return '—';
    }
  }
  const s = String(value);
  return s === 'undefined' || s === 'null' || s === '' ? '—' : s;
}

function normalizeRiskLevel(value: unknown): Case['riskLevel'] {
  const v = String(value ?? '').toLowerCase().trim();
  if (v.includes('extremely') || v.includes('severe') || v === 'critical') return 'Critical';
  if (v.includes('high') || v.includes('moderate') || v === 'moderate') return 'High';
  if (v === 'medium' || v === 'mild') return 'Medium';
  return 'Low';
}

function normalizeStatus(value: unknown): Case['status'] {
  const v = String(value ?? '').toLowerCase().trim();
  if (v === 'escalated') return 'Escalated';
  if (v === 'resolved') return 'Resolved';
  return 'Open';
}

function parseCase(id: string, data: Record<string, unknown>): Case {
  const rawRisk =
    data.classificationLevel ?? data.riskLevel ?? data.risk_level ?? data.level ??
    data.severity ?? data.alertLevel ?? data.mentalHealthRisk ?? data.risk;

  return {
    id,
    userId: (data.userId ?? data.uid ?? data.user_id ?? id) as string,
    userName: (data.nickname ?? data.nickName ?? data.userName ?? data.name ?? data.displayName ?? data.fullName ?? 'Unknown') as string,
    riskLevel: normalizeRiskLevel(rawRisk),
    lastActivity: toDateString(data.lastActivity ?? data.last_active ?? data.lastSeen ?? data.updatedAt),
    reason: (data.reason ?? data.flagReason ?? data.description ?? data.aiFlag ?? data.notes ?? 'Risk detected') as string,
    status: normalizeStatus(data.status),
  };
}

const HIGH_RISK: Case['riskLevel'][] = ['Critical', 'High'];
const RISK_ORDER: Record<Case['riskLevel'], number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export default function CriticalCases() {
  const { currentUser } = useAuth();
  const location = useLocation();

  // ── Alert-driven highlight ────────────────────────────────────────────────
  // When the advisor clicks "Review Case" from a notification, connectionId is
  // passed via route state (or ?connectionId= query param as fallback).
  const [highlightedConnectionId, setHighlightedConnectionId] = useState<string | null>(null);

  // Refs keyed by connection id — used to scroll the highlighted card into view
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setCardRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    [],
  );

  // Resolve highlight target from route state or query param
  useEffect(() => {
    const stateId = (location.state as { connectionId?: string } | null)?.connectionId;
    const queryId = new URLSearchParams(location.search).get('connectionId');
    const target = stateId ?? queryId ?? null;
    setHighlightedConnectionId(target);
  }, [location]);

  // Advisor connections state
  const [connections, setConnections] = useState<AdvisorConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [connSearch, setConnSearch] = useState('');
  const [connStatusFilter, setConnStatusFilter] = useState<'All' | 'pending' | 'accepted'>('All');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [isCaseDetailsOpen, setIsCaseDetailsOpen] = useState(false);

  // AI-flagged cases state (existing)
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isNotesModalOpen, setIsNotesModalOpen] = useState(false);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [isDirectChatOpen, setIsDirectChatOpen] = useState(false);
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<'All' | 'Critical' | 'High'>('All');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Open' | 'Escalated' | 'Resolved'>('All');

  const casesHasData = useRef(false);

  // Advisor connections real-time listener
  useEffect(() => {
    if (!currentUser) {
      setConnectionsLoading(false);
      return;
    }

    setConnectionsLoading(true);
    const unsub = listenToCriticalCases(
      currentUser.uid,
      (conns) => {
        setConnections(conns);
        setConnectionsLoading(false);
        setConnectionsError(null);

        // Trigger backend alert creation + email for each new pending connection
        conns
          .filter((c) => c.status === 'pending')
          .forEach((c) => processConnectionAlert(c.id, () => currentUser.getIdToken()));
      },
      () => {
        setConnectionsError('Could not load connection requests. Check Firestore permissions.');
        setConnectionsLoading(false);
      }
    );

    return unsub;
  }, [currentUser]);

  // AI-flagged cases listener (existing logic)
  useEffect(() => {
    setLoading(true);
    casesHasData.current = false;

    const unsubUsers = onSnapshot(
      collection(db, 'users'),
      async (snap) => {
        if (casesHasData.current) return;

        const profileResults = await Promise.all(
          snap.docs.map((d) =>
            getDoc(doc(db, 'users', d.id, 'mentalHealthProfile', 'currentProfile'))
              .then((p) => ({ id: d.id, data: (p.exists() ? p.data() : {}) as Record<string, unknown> }))
              .catch(() => ({ id: d.id, data: {} as Record<string, unknown> }))
          )
        );
        const profileMap = new Map(profileResults.map((p) => [p.id, p.data]));

        const fetched = snap.docs.map((d) => {
          const userData = d.data() as Record<string, unknown>;
          const profileData = profileMap.get(d.id) ?? {};
          const merged: Record<string, unknown> = { ...userData };
          if (profileData.classificationLevel) {
            merged.classificationLevel = profileData.classificationLevel;
          } else if (profileData.activeRecommendationCategory) {
            merged.classificationLevel = profileData.activeRecommendationCategory;
          } else {
            const iqScore = profileData.initialQuestionnaireScore as Record<string, unknown> | undefined;
            if (iqScore?.category) merged.classificationLevel = iqScore.category;
          }
          return parseCase(d.id, merged);
        });

        const hasRiskData = fetched.some((c) => c.riskLevel !== 'Low');
        const display = hasRiskData ? fetched.filter((c) => HIGH_RISK.includes(c.riskLevel)) : fetched;
        setCases(display);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('[CriticalCases] users collection error:', err);
        if (!casesHasData.current) {
          setError('Could not load users. Check Firestore permissions.');
          setLoading(false);
        }
      }
    );

    const unsubCases = onSnapshot(
      collection(db, 'cases'),
      (snap) => {
        if (snap.empty) {
          casesHasData.current = false;
          return;
        }
        const fetched = snap.docs
          .map((d) => parseCase(d.id, d.data() as Record<string, unknown>))
          .filter((c) => HIGH_RISK.includes(c.riskLevel) || c.status !== 'Resolved');

        if (fetched.length > 0) {
          casesHasData.current = true;
          setCases(fetched);
          setLoading(false);
          setError(null);
        }
      },
      () => {}
    );

    return () => {
      unsubUsers();
      unsubCases();
    };
  }, []);

  const filteredConnections = connections
    .filter((c) => {
      if (c.caseType === 'listener_support') return false;
      const cat = (c.userMentalHealthCategory ?? '').toLowerCase();
      return c.caseType === 'critical_case' || cat.includes('severe') || cat.includes('critical');
    })
    .filter((c) =>
      connSearch === '' ||
      (c.nickName ?? c.userName).toLowerCase().includes(connSearch.toLowerCase()) ||
      c.userEmail.toLowerCase().includes(connSearch.toLowerCase())
    )
    .filter((c) => connStatusFilter === 'All' || c.status === connStatusFilter)
    .sort((a, b) => {
      const aTs = (a.createdAt as { seconds?: number })?.seconds ?? 0;
      const bTs = (b.createdAt as { seconds?: number })?.seconds ?? 0;
      return bTs - aTs;
    });

  const filteredCases = cases
    .filter(
      (c) =>
        searchQuery === '' ||
        c.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.id.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .filter((c) => riskFilter === 'All' || c.riskLevel === riskFilter)
    .filter((c) => statusFilter === 'All' || c.status === statusFilter)
    .sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);

  // Scroll to and briefly highLight the connection when navigating from an alert
  useEffect(() => {
    if (!highlightedConnectionId || connectionsLoading) return;
    const el = cardRefs.current.get(highlightedConnectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedConnectionId, connectionsLoading, connections]);

  // Close the case details modal if the connection is removed from the active list (e.g. after review)
  useEffect(() => {
    if (isCaseDetailsOpen && selectedConnectionId && !connections.find((c) => c.id === selectedConnectionId)) {
      setIsCaseDetailsOpen(false);
    }
  }, [connections, selectedConnectionId, isCaseDetailsOpen]);

  async function handleAccept(conn: AdvisorConnection) {
    if (!currentUser) return;
    await acceptAdvisorConnection(conn.id, conn.userId, currentUser.uid);
  }

  async function handleMarkReviewed(conn: AdvisorConnection) {
    await markCaseReviewed(conn.id, conn.userId);
  }

  function handleOpenCaseDetails(conn: AdvisorConnection) {
    setSelectedConnectionId(conn.id);
    setIsCaseDetailsOpen(true);
  }

  const handleViewDetails = (c: Case) => {
    setSelectedCase(c);
    setIsDetailsModalOpen(true);
  };

  const handleAddNote = (c: Case) => {
    setSelectedCase(c);
    setIsNotesModalOpen(true);
  };

  const handleOpenChat = (c: Case) => {
    setSelectedCase(c);
    setIsDirectChatOpen(true);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-8"
    >
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <AlertTriangle className="text-red-500" size={32} />
            Critical Cases
          </h1>
          <p className="text-slate-500 mt-1">High-risk users requiring immediate advisor review.</p>
        </div>
      </header>

      {/* ── Advisor Connection Requests ── */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <UserCheck size={20} className="text-brand-500" />
              <h2 className="text-xl font-bold text-slate-800">Connection Requests</h2>
              {filteredConnections.length > 0 && (
                <span className="text-xs font-bold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">
                  {filteredConnections.length}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Severe and critical cases requiring immediate attention. Routine support requests appear under{' '}
              <Link to="/listener-requests" className="text-brand-500 hover:underline">
                Listener Requests
              </Link>
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
              <input
                type="text"
                value={connSearch}
                onChange={(e) => setConnSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-brand-300 rounded-xl outline-none text-sm transition-all w-52"
              />
            </div>
            <div className="inline-flex rounded-full border border-slate-200 overflow-hidden bg-slate-100">
              {(['All', 'pending', 'accepted'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setConnStatusFilter(option)}
                  className={`px-4 py-2 text-sm font-semibold transition-colors ${
                    connStatusFilter === option
                      ? 'bg-white text-brand-600 shadow-sm'
                      : 'text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {option === 'All' ? 'All' : option.charAt(0).toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {connectionsError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {connectionsError}
          </div>
        )}

        {!currentUser ? (
          <div className="text-center py-10 bg-slate-50 rounded-2xl border border-slate-200">
            <Users size={36} className="mx-auto mb-3 text-slate-300" />
            <p className="text-slate-500 font-medium">Sign in to view your connection requests.</p>
          </div>
        ) : connectionsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-52 rounded-2xl bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : filteredConnections.length === 0 ? (
          <div className="text-center py-10 bg-slate-50 rounded-2xl border border-slate-200">
            <UserCheck size={36} className="mx-auto mb-3 text-slate-300" />
            <p className="text-slate-500 font-medium">
              {filteredConnections.length === 0 && connections.length > 0
                ? 'No requests match the current filters.'
                : 'No critical connection requests yet.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredConnections.map((conn) => {
              const isHighlighted = conn.id === highlightedConnectionId;
              return (
                <div
                  key={conn.id}
                  ref={setCardRef(conn.id)}
                  className={[
                    'rounded-2xl transition-all duration-500',
                    isHighlighted
                      ? 'ring-2 ring-rose-500 ring-offset-2 shadow-lg shadow-rose-100'
                      : '',
                  ].join(' ')}
                >
                  <ConnectionCard
                    connection={conn}
                    onAccept={handleAccept}
                    onMarkReviewed={handleMarkReviewed}
                    onClick={handleOpenCaseDetails}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Divider ── */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-slate-200" />
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">AI-Flagged Cases</span>
        <div className="flex-1 h-px bg-slate-200" />
      </div>

      {/* ── AI-Flagged Cases (existing) ── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={18} className="text-amber-500" />
          <h2 className="text-xl font-bold text-slate-800">AI-Flagged High-Risk Users</h2>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-white p-4 rounded-2xl border border-slate-200">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by name or case ID..."
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border-transparent focus:bg-white focus:border-brand-300 rounded-xl outline-none text-sm transition-all"
            />
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value as typeof riskFilter)}
              className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-semibold outline-none border-none hover:bg-slate-200 transition-colors"
            >
              <option value="All">All Risk Levels</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-semibold outline-none border-none hover:bg-slate-200 transition-colors"
            >
              <option value="All">All Statuses</option>
              <option value="Open">Open</option>
              <option value="Escalated">Escalated</option>
              <option value="Resolved">Resolved</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-48 rounded-2xl bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : filteredCases.length === 0 ? (
          <div className="text-center py-16">
            <AlertTriangle size={48} className="mx-auto mb-4 text-slate-300" />
            <p className="text-lg font-semibold text-slate-500">No AI-flagged cases found</p>
            <p className="text-sm text-slate-400 mt-1">
              {cases.length === 0
                ? 'No high-risk users in the database yet.'
                : 'No users match the current filters.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredCases.map((c) => (
              <CaseCard
                key={c.id}
                caseData={c}
                onViewDetails={() => handleViewDetails(c)}
                onAddNote={() => handleAddNote(c)}
                onOpenChat={() => handleOpenChat(c)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Protocol reminder */}
      <div className="bg-brand-50 rounded-3xl p-8 border border-brand-100 flex flex-col md:flex-row items-center gap-8">
        <div className="w-20 h-20 bg-brand-500 rounded-3xl flex items-center justify-center text-white shrink-0 shadow-xl shadow-brand-200">
          <AlertTriangle size={40} />
        </div>
        <div className="flex-1 text-center md:text-left">
          <h3 className="text-xl font-bold text-slate-800 mb-2">Protocol Reminder</h3>
          <p className="text-slate-600 leading-relaxed">
            For all <span className="font-bold text-red-600">Critical</span> Risk cases, advisors must initiate
            contact within 15 minutes of detection. Ensure all intervention steps are documented in the Advisor
            Notes section.
          </p>
        </div>
        <button className="px-8 py-3 bg-white text-brand-600 rounded-2xl font-bold border border-brand-200 hover:bg-brand-50 transition-all">
          View Protocol
        </button>
      </div>

      {isCaseDetailsOpen && selectedConnectionId && (() => {
        const conn = connections.find((c) => c.id === selectedConnectionId);
        return conn ? (
          <CaseDetailsModal
            isOpen={isCaseDetailsOpen}
            onClose={() => setIsCaseDetailsOpen(false)}
            connection={conn}
          />
        ) : null;
      })()}

      <NotesModal
        isOpen={isNotesModalOpen}
        onClose={() => setIsNotesModalOpen(false)}
        userName={selectedCase?.userName ?? ''}
      />

      {selectedCase && (
        <UserDetailsModal
          isOpen={isDetailsModalOpen}
          onClose={() => setIsDetailsModalOpen(false)}
          userId={selectedCase.userId}
          userName={selectedCase.userName}
          riskLevel={selectedCase.riskLevel}
          onOpenChat={() => {
            setIsDetailsModalOpen(false);
            setIsDirectChatOpen(true);
          }}
        />
      )}

      {selectedCase && (
        <DirectChatModal
          isOpen={isDirectChatOpen}
          onClose={() => setIsDirectChatOpen(false)}
          caseData={selectedCase}
          onViewProfile={() => {
            setIsDirectChatOpen(false);
            setIsDetailsModalOpen(true);
          }}
        />
      )}
    </motion.div>
  );
}
