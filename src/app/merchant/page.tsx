"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ApiMandate, type ApiPlan, type MerchantSummary } from "@/lib/api";
import { buildCsv, downloadCsv, exportFilename, type ChargeRow } from "@/lib/csv";
import { chainMandatesFor, chainMerchantSummary, chainPlansOf, endable, mandateFunding } from "@/lib/chain";
import { config } from "@/lib/config";
import { MAX_NAME_LEN, nameByteLength, payflow, server } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import { formatPeriod, formatWhen, fromStroops, toStroops } from "@/lib/format";
import { AddressLink, Badge, Empty, Notice, Panel, Stat, TxLink } from "@/components/ui";

const PERIOD_OPTIONS = [
  { label: "Every minute (demo)", value: 60 },
  { label: "Daily", value: 86_400 },
  { label: "Weekly", value: 604_800 },
  { label: "Monthly", value: 2_592_000 },
  { label: "Yearly", value: 31_536_000 },
];

export default function MerchantPage() {
  const { address, networkMismatch, signXdr } = useWallet();
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [mandates, setMandates] = useState<ApiMandate[] | null>(null);
  const [summary, setSummary] = useState<MerchantSummary | null>(null);
  // Vault balance per subscriber address, read in parallel with mandates.
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [exporting, setExporting] = useState(false);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [period, setPeriod] = useState(2_592_000);
  const [busy, setBusy] = useState<string | null>(null);
  // Ending is permanent, so the End button asks for a second click.
  const [confirmEnd, setConfirmEnd] = useState<number | null>(null);
  // The contract rejects a name over MAX_NAME_LEN bytes, so catch it here
  // rather than letting the user pay for a transaction that will fail.
  const nameTooLong = nameByteLength(name.trim()) > MAX_NAME_LEN;
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    const [p, m, s] = await Promise.all([
      api.plans(address),
      api.mandatesFor(address),
      api.merchantSummary(address),
    ]);
    if (p) {
      setPlans(p.plans);
    } else {
      try {
        setPlans(await chainPlansOf(address, address));
      } catch {
        setPlans([]);
      }
    }

    let rows: ApiMandate[] = [];
    if (m) {
      rows = m.mandates;
    } else {
      try {
        rows = await chainMandatesFor(address, address);
      } catch {
        rows = [];
      }
    }
    setMandates(rows);

    // Revenue totals come from charge history, which only the indexer has.
    setSummary(s ?? chainMerchantSummary(address, rows));

    // Read each subscriber's vault balance in parallel so the dashboard can
    // flag mandates that will fail. Individual reads may fail without breaking
    // the whole list.
    const subscribers = [...new Set(rows.map((m) => m.subscriber))];
    const settled = await Promise.allSettled(
      subscribers.map((sub) => payflow.vaultBalance(address, sub, config.contracts.token)),
    );
    const b: Record<string, bigint | null> = {};
    subscribers.forEach((sub, i) => {
      if (settled[i]?.status === "fulfilled") b[sub] = settled[i].value;
    });
    setBalances(b);
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Gather every charge settled against the merchant's mandates and download it as CSV. */
  async function exportCsv() {
    setExporting(true);
    try {
      const dateCache = new Map<string, string>();
      async function chargeDate(txHash: string): Promise<string> {
        if (dateCache.has(txHash)) return dateCache.get(txHash)!;
        let date = "—";
        try {
          const tx = await server.getTransaction(txHash);
          // Only successful/failed transactions carry a creation timestamp.
          if ("createdAt" in tx) {
            const createdAt = tx.createdAt as number;
            const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
            date = new Date(ms).toISOString().slice(0, 10);
          }
        } catch {
          // Best-effort: contract-only mode or RPC failure leaves the date blank.
        }
        dateCache.set(txHash, date);
        return date;
      }

      const rows: ChargeRow[] = [];
      for (const m of mandates ?? []) {
        const res = await api.charges(m.id);
        if (!res) continue;
        for (const c of res.charges) {
          const amount = BigInt(c.amount);
          const fee = BigInt(c.fee);
          rows.push({
            date: await chargeDate(c.tx_hash),
            mandateId: c.mandate_id,
            subscriber: m.subscriber,
            gross: fromStroops(amount),
            fee: fromStroops(fee),
            net: fromStroops(amount - fee),
            txHash: c.tx_hash,
          });
        }
      }

      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const dates = rows.map((r) => r.date).filter((d) => d !== "—");
      const from = dates.length ? dates[0]! : "all";
      const to = dates.length ? dates[dates.length - 1]! : "all";

      downloadCsv(
        buildCsv(rows),
        exportFilename(address!, from, to),
      );
    } finally {
      setExporting(false);
    }
  }

  if (!address) {
    return (
      <Panel title="Merchant dashboard">
        <Empty>Connect a wallet to publish plans and track revenue.</Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Collected"
          value={summary?.totalCollected ? `${fromStroops(summary.totalCollected)}` : "—"}
          hint="XLM, net of protocol fee"
        />
        <Stat label="Active mandates" value={summary?.activeMandates ?? "…"} />
        <Stat label="Charges settled" value={summary?.chargeCount ?? "…"} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          Done. Transaction <TxLink hash={done} />
        </Notice>
      )}

      <Panel
        title="Publish a plan"
        subtitle="Price and period are frozen into every mandate opened against this plan. To change them, publish a new plan."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="price">
              Price (XLM)
            </label>
            <input
              id="price"
              className="input"
              inputMode="decimal"
              placeholder="1.0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="label" htmlFor="plan-name">
              Plan name
            </label>
            <input
              id="plan-name"
              className="input"
              placeholder="Pro Monthly"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameTooLong}
              aria-describedby={nameTooLong ? "plan-name-error" : undefined}
            />
            {nameTooLong && (
              <p id="plan-name-error" className="mt-1 text-sm text-rose-200">
                Too long — {MAX_NAME_LEN} bytes maximum.
              </p>
            )}
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="period">
              Billing period
            </label>
            <select
              id="period"
              className="input"
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null || networkMismatch || nameTooLong}
            onClick={() =>
              void run("create", () =>
                payflow.createPlan(address, signXdr, {
                  token: config.contracts.token,
                  amount: toStroops(price),
                  period,
                  name: name.trim(),
                }),
              )
            }
          >
            {busy === "create" ? "Publishing…" : "Publish plan"}
          </button>
        </div>
      </Panel>

      <Panel title="My plans">
        {plans === null ? (
          <Empty>Loading…</Empty>
        ) : plans.length === 0 ? (
          <Empty>No plans yet.</Empty>
        ) : (
          <div className="space-y-3">
            {plans.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge p-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name || `Plan #${p.id}`}</span>
                    <Badge status={p.active ? "Active" : "Paused"} />
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {fromStroops(p.amount)} XLM {formatPeriod(p.period)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy !== null || networkMismatch}
                  onClick={() =>
                    void run(`toggle-${p.id}`, () =>
                      payflow.setPlanActive(address, signXdr, p.id, p.active !== 1),
                    )
                  }
                >
                  {p.active ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Subscribers"
        subtitle="Charging is permissionless — you can settle a due mandate yourself instead of waiting for the keeper."
        actions={
          <button
            type="button"
            className="btn-ghost mono text-sm"
            disabled={exporting || mandates?.length === 0 || networkMismatch}
            onClick={() => void exportCsv()}
            aria-label="Export charges to CSV"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        }
      >
        {mandates === null ? (
          <Empty>Loading…</Empty>
        ) : mandates.length === 0 ? (
          <Empty>No subscribers yet.</Empty>
        ) : (
          <div className="space-y-3">
            {mandates.map((m) => {
              const due = m.status === "Active" && m.next_charge * 1000 <= Date.now();
              const balance = balances[m.subscriber] ?? null;
              const funding = mandateFunding(balance, BigInt(m.amount));
              const short = funding.status === "short";
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge p-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">#{m.id}</span>
                      <AddressLink value={m.subscriber} />
                      <Badge status={m.status} />
                      {m.ended_by === "merchant" && (
                        <span className="text-xs text-muted">ended by you</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {fromStroops(m.amount)} XLM {formatPeriod(m.period)} ·{" "}
                      {m.charges_made} settled · next{" "}
                      {m.status === "Active" ? formatWhen(m.next_charge) : "—"}
                    </div>
                    <div className="mt-1 text-xs font-medium">
                      {balance === null ? (
                        <span className="text-muted">Vault balance —</span>
                      ) : short ? (
                        <span className="text-rose-300">
                          Short by {fromStroops(funding.shortfall)} XLM
                        </span>
                      ) : (
                        <span className="text-accent">Funded</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {due && (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy !== null || networkMismatch || short}
                          onClick={() =>
                            void run(`charge-${m.id}`, () =>
                              payflow.charge(address, signXdr, m.id),
                            )
                          }
                        >
                          {busy === `charge-${m.id}` ? "Charging…" : short ? "Short on funds" : "Charge now"}
                        </button>
                        {short && (
                          <span className="text-xs text-rose-300">
                            Subscriber vault short by {fromStroops(funding.shortfall)} XLM
                          </span>
                        )}
                      </>
                    )}
                    {endable(m) &&
                      (confirmEnd === m.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null}
                            onClick={() => setConfirmEnd(null)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busy !== null || networkMismatch}
                            onClick={() =>
                              void run(`end-${m.id}`, () =>
                                payflow.endMandate(address, signXdr, m.id),
                              ).then(() => setConfirmEnd(null))
                            }
                          >
                            {busy === `end-${m.id}` ? "Ending…" : "Confirm: end for good"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy !== null || networkMismatch}
                          onClick={() => setConfirmEnd(m.id)}
                          aria-label={`End subscription #${m.id}`}
                        >
                          End
                        </button>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
