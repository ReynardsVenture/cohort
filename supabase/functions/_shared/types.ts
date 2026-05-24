export type ChannelType = "telegram" | "whatsapp" | "sms" | "web";

export type CoreAction =
  | { type: "OnboardingMessage"; userId: string; text: string }
  | { type: "CompleteOnboarding"; userId: string }
  | { type: "SendSpark"; userId: string; toUserId: string; roundId: string; style: string; message: string; intentLevel: string }
  | { type: "RespondSpark"; userId: string; sparkId: string; accept: boolean }
  | { type: "SubmitThreadTurn"; userId: string; threadId: string; response: string }
  | { type: "SubmitContract"; userId: string; threadId: string; decision: "yes" | "no"; pace?: string }
  | { type: "SendRelayMessage"; userId: string; threadId: string; body: string; clientMessageId?: string }
  | { type: "BlockUser"; userId: string; blockedId: string }
  | { type: "ReportUser"; userId: string; reportedId: string; reason: string; threadId?: string };

export interface OutboundIntent {
  userId: string;
  channel: ChannelType;
  templateKey: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CoreResult {
  success: boolean;
  message?: string;
  outboundIntents?: OutboundIntent[];
  data?: Record<string, unknown>;
}
