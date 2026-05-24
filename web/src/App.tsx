/**
 * Cohort web channel (Phase 11) — minimal shell.
 * Primary journey runs in Telegram/WhatsApp; web supports account & GDPR flows.
 */
export default function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-serif mb-4">Cohort</h1>
      <p className="text-center max-w-md text-lg mb-8">
        Slow dating through conversation — not swipes. Chat with our matchmaker on Telegram to start.
      </p>
      <a
        href="https://meetcohort.co"
        className="px-6 py-3 bg-cohort-ink text-cohort-cream rounded-full"
      >
        meetcohort.co
      </a>
      <p className="mt-12 text-sm opacity-60">
        KI-Matchmaker — klar als KI gekennzeichnet, kein Ersatz für echte Begegnungen.
      </p>
    </div>
  );
}
