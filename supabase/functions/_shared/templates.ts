// Render outbound message bodies per template_key and channel

export function renderTemplate(
  templateKey: string,
  payload: Record<string, unknown>,
  locale = "de",
): string {
  const de = locale === "de";
  switch (templateKey) {
    case "welcome_new":
      return de
        ? "Willkommen bei Cohort. Ich bin dein KI-Matchmaker (kein Mensch, kein Ersatz für echte Begegnungen). Schreib mir, wer du bist — wir starten mit einem kurzen Gespräch."
        : "Welcome to Cohort. I'm your AI matchmaker (not a human, not a substitute for real connection). Tell me about yourself — we'll start with a short conversation.";
    case "ai_disclosure":
      return de
        ? "Hinweis: Du chattest mit einer KI, die Gespräche moderiert und Matches vorschlägt — nicht mit einer Person, die sich als Partner ausgibt."
        : "Note: You're chatting with AI that facilitates conversation and suggests matches — not a person posing as a date.";
    case "round_ready":
      return de
        ? `Deine neue Runde für diese Woche ist da. ${payload.suggestion_count ?? 0} Vorschläge mit Begründung warten auf dich.`
        : `Your new round is ready. ${payload.suggestion_count ?? 0} reasoned suggestions await.`;
    case "no_round_this_week":
      return de
        ? "Diese Woche haben wir keinen passenden, begründeten Vorschlag für dich — Qualität vor Quantität. Nächste Woche versuchen wir es erneut."
        : "No confident, reasoned match for you this week — quality over quantity. We'll try again next week.";
    case "spark_received":
      return de
        ? `Jemand hat dir einen Funken geschickt: "${payload.preview ?? ""}" — Antworte mit JA oder NEIN.`
        : `Someone sent you a spark: "${payload.preview ?? ""}" — reply YES or NO.`;
    case "spark_accepted":
      return de
        ? "Euer Funken wurde angenommen. Ich begleite euer Gespräch — antwortet, wenn ihr bereit seid."
        : "Your spark was accepted. I'll facilitate your conversation — reply when ready.";
    case "spark_declined":
      return de
        ? "Dein Funken wurde leider abgelehnt. Keine Sorge — es gibt noch andere Möglichkeiten in dieser Runde."
        : "Your spark was declined. There may be other options this round.";
    case "thread_prompt":
      return de
        ? `Nächste Frage für euch beide:\n\n${payload.prompt ?? ""}`
        : `Next question for you both:\n\n${payload.prompt ?? ""}`;
    case "contract_request":
      return de
        ? "Ihr seid bereit für den Vertrag: Möchtet ihr weitermachen? Antwortet mit JA/NEIN und eurem Tempo (heute / diese Woche / langsam)."
        : "Ready for the contract: continue? Reply YES/NO and pace (today / this_week / slow).";
    case "reveal_unlocked":
      return de
        ? "Ihr habt beide ja gesagt — Fotos sind freigeschaltet. Viel Erfolg beim Kennenlernen."
        : "You both said yes — photos are unlocked. Enjoy getting to know each other.";
    case "relay_message":
      return de
        ? `${payload.alias ?? "Dein Match"}: ${payload.body ?? ""}`
        : `${payload.alias ?? "Your match"}: ${payload.body ?? ""}`;
    case "otp_code":
      return de
        ? `Dein Cohort-Code: ${payload.code ?? "------"}`
        : `Your Cohort code: ${payload.code ?? "------"}`;
    case "age_gate_required":
      return de
        ? "Bitte bestätige dein Geburtsdatum (TT.MM.JJJJ), um fortzufahren. Nur 18+."
        : "Please confirm your date of birth (DD.MM.YYYY). 18+ only.";
    case "safety_notice":
      return String(payload.message ?? (de ? "Sicherheitshinweis von Cohort." : "Safety notice from Cohort."));
    default:
      return String(payload.text ?? templateKey);
  }
}
