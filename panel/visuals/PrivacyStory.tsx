import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@mui/material";
import { Link } from "react-router";
import { usePanelLanguage } from "../lib/language";
import "./privacy-story.css";

const PrivacyScene = lazy(() => import("./PrivacyScene"));
const content = {
  en: {
    eyebrow: "YOUR MONEY. YOUR BUSINESS.", title: "Transparency is good.", emphasis: "Privacy is essential.",
    intro: "Would you let a stranger read your grocery receipts? Or your salary? Paying with crypto shouldn't mean publishing your life.",
    scenarios: ["Groceries", "Salary", "Pharmacy"], merchants: ["Corner market", "Monthly salary", "Local pharmacy"],
    amounts: ["42.80", "3,250.00", "18.40"], parties: ["You → Market", "Employer → You", "You → Pharmacy"],
    public: "Public ledger", private: "Protect the amount", payment: "YOUR PAYMENT", observer: "WHAT EVERYONE SEES",
    publicStatus: "A payment. A public record.", privateStatus: "Verified payment. Private amount.",
    publicDescription: "One address links your everyday payments. Anyone can read the amounts.",
    privateDescription: "The network verifies the payment. The amount belongs to you and the parties involved.",
    exposed: "Amount visible to everyone", protected: "Amount encrypted", verified: "Verified on-chain", hidden: "Encrypted", unit: "USDC",
    play: "Play the story", pause: "Pause", replay: "Replay", reduced: "Reduced motion enabled",
    steps: ["Make a payment", "See the exposure", "Keep the amount private"],
    note: "Illustrative transactions. Hiding amounts does not automatically hide addresses or payment relationships.",
    cta: "Explore private payments", scenarioLabel: "Payment example", modeLabel: "Compare payment visibility",
  },
  tr: {
    eyebrow: "SENİN PARAN. SENİN HAYATIN.", title: "Şeffaflık güzel bir şey.", emphasis: "Mahremiyet zorunluluk.",
    intro: "Bir yabancının market fişlerini okumasını ister miydin? Peki maaşını? Kriptoyla ödeme yapmak, hayatını herkese açmak olmamalı.",
    scenarios: ["Market", "Maaş", "Eczane"], merchants: ["Mahalle marketi", "Aylık maaş", "Mahalle eczanesi"],
    amounts: ["42,80", "3.250,00", "18,40"], parties: ["Sen → Market", "İşveren → Sen", "Sen → Eczane"],
    public: "Açık defter", private: "Tutarı koru", payment: "SENİN ÖDEMEN", observer: "HERKESİN GÖRDÜĞÜ",
    publicStatus: "Bir ödeme. Herkese açık bir kayıt.", privateStatus: "Ödeme doğrulandı. Tutar gizli.",
    publicDescription: "Tek bir adres, günlük ödemelerini birbirine bağlıyor. Tutarları herkes okuyabiliyor.",
    privateDescription: "Ağ ödemeyi doğrular. Tutar, seninle işlemin tarafları arasında kalır.",
    exposed: "Tutar herkese açık", protected: "Tutar şifreli", verified: "Zincirde doğrulandı", hidden: "Şifreli", unit: "USDC",
    play: "Hikâyeyi oynat", pause: "Duraklat", replay: "Tekrar izle", reduced: "Hareket azaltma açık",
    steps: ["Ödemeni yap", "Görünürlüğü fark et", "Tutarı gizli tut"],
    note: "Temsili işlemler. Tutarın gizlenmesi, adresleri veya ödeme ilişkilerini kendiliğinden gizlemez.",
    cta: "Gizli ödemeleri keşfet", scenarioLabel: "Ödeme örneği", modeLabel: "Ödeme görünürlüğünü karşılaştır",
  },
};
const icons = ["↗", "↓", "+"];

export default function PrivacyStory() {
  const { language } = usePanelLanguage();
  const c = content[language];
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [tabVisible, setTabVisible] = useState(!document.hidden);
  const [scenario, setScenario] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const privateMode = elapsed >= 7;
  const running = playing && !reduced && visible && tabVisible;
  const step = privateMode ? 2 : elapsed >= 3 ? 1 : 0;
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.1 });
    if (section.current) observer.observe(section.current);
    const visibility = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setElapsed(value => Math.min(14, value + 0.1)), 100);
    return () => window.clearInterval(interval);
  }, [running]);
  useEffect(() => { if (elapsed >= 14) setPlaying(false); }, [elapsed]);
  const chooseMode = (protect: boolean) => { setElapsed(protect ? 10 : 4); setPlaying(false); };

  return (
    <section className="privacy-story" ref={section} aria-labelledby="privacy-story-heading">
      <div className="privacy-story-intro">
        <div>
          <p className="privacy-eyebrow"><span />{c.eyebrow}</p>
          <h1 id="privacy-story-heading">{c.title}<br /><span>{c.emphasis}</span></h1>
        </div>
        <p className="privacy-story-description">{c.intro}</p>
      </div>
      <div className={`privacy-stage ${privateMode ? "is-private" : "is-public"}`}>
        <Suspense fallback={<div className="privacy-scene-fallback" aria-hidden="true">◇</div>}>
          <PrivacyScene privateMode={privateMode} running={running} />
        </Suspense>
        <div className="privacy-stage-toolbar">
          <div className="privacy-scenarios" role="group" aria-label={c.scenarioLabel}>
            {c.scenarios.map((label, index) => <button key={index} type="button" aria-pressed={scenario === index}
              onClick={() => { setScenario(index); setElapsed(0); setPlaying(!reduced); }}>
              <span aria-hidden="true">{icons[index]}</span>{label}
            </button>)}
          </div>
          <span className="privacy-demo-badge">DEMO · USDC</span>
        </div>
        <div className="privacy-payment-card">
          <div className="privacy-card-eyebrow">{c.payment}<span aria-hidden="true">↗</span></div>
          <div className="privacy-merchant-icon" aria-hidden="true">{icons[scenario]}</div>
          <h2>{c.merchants[scenario]}</h2>
          <p className="privacy-amount">{c.amounts[scenario]} <small>{c.unit}</small></p>
          <p className="privacy-parties">{c.parties[scenario]}</p>
          <div className="privacy-verified"><span aria-hidden="true">✓</span>{c.verified}</div>
        </div>
        <div className="privacy-ledger-card">
          <div className="privacy-card-eyebrow">{c.observer}<span className="privacy-live-dot" /></div>
          <p className="privacy-address">G7XA…9K2F <span>↗</span></p>
          {c.scenarios.map((label, index) => <div key={index} className={`privacy-ledger-row ${scenario === index ? "is-selected" : ""}`}>
            <span><span className="privacy-row-icon" aria-hidden="true">{icons[index]}</span>{label}</span>
            <strong>{privateMode ? "••••••" : c.amounts[index]}<small>{privateMode ? c.hidden : "USDC"}</small></strong>
          </div>)}
          <div className="privacy-exposure"><span aria-hidden="true">{privateMode ? "◈" : "◎"}</span>{privateMode ? c.protected : c.exposed}</div>
        </div>
        <div className="privacy-stage-caption" aria-live="polite">
          <strong>{privateMode ? c.privateStatus : c.publicStatus}</strong>
          <p>{privateMode ? c.privateDescription : c.publicDescription}</p>
        </div>
        <div className="privacy-timeline" aria-hidden="true"><span style={{ width: `${elapsed / 14 * 100}%` }} /></div>
      </div>
      <div className="privacy-controls">
        <div className="privacy-mode-control" role="group" aria-label={c.modeLabel}>
          <button type="button" onClick={() => chooseMode(false)} aria-pressed={!privateMode}>◎ {c.public}</button>
          <button type="button" onClick={() => chooseMode(true)} aria-pressed={privateMode}>◈ {c.private}</button>
        </div>
        {reduced ? <span className="privacy-motion-note">{c.reduced}</span> : <button className="privacy-play" type="button" onClick={() => {
          if (elapsed >= 14) { setElapsed(0); setPlaying(true); } else setPlaying(value => !value);
        }}><span aria-hidden="true">{playing ? "Ⅱ" : "▷"}</span>{playing ? c.pause : elapsed >= 14 ? c.replay : c.play}</button>}
      </div>
      <ol className="privacy-steps">{c.steps.map((label, index) => <li key={index} aria-current={step === index ? "step" : undefined}><span>0{index + 1}</span>{label}</li>)}</ol>
      <div className="privacy-story-footer"><p>{c.note}</p><Link to="/payroll">{c.cta}<span aria-hidden="true">↗</span></Link></div>
    </section>
  );
}
