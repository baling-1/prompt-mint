import express from "express";
import {
  DeleteWebhook,
  GetWebhook,
  GetWebhookDeadLetters,
  GetWebhookDeliveries,
  GetWebhookHealth,
  GetWebhookReplayEvents,
  GetWebhookReplayQueue,
  PreviewWebhookReplay,
  RegisterWebhook,
  ReplayWebhookDeadLetter,
  RotateWebhookSecret,
  TestWebhook,
  validatePreviewWebhookEvent,
  validateRegisterWebhook,
} from "../controllers/webhookControllers";
import { validateBody } from "../middleware/validateRequest";
import { z } from "zod";

const WalletAddressBody = z.object({
  walletAddress: z.string().trim().min(1, "walletAddress is required."),
}).strict();

export const webhookRouter = express.Router();

webhookRouter.post("/", validateRegisterWebhook, RegisterWebhook);
webhookRouter.get("/", GetWebhook);
webhookRouter.delete("/", validateBody(WalletAddressBody), DeleteWebhook);
webhookRouter.post("/rotate-secret", validateBody(WalletAddressBody), RotateWebhookSecret);
webhookRouter.post("/test", validateBody(WalletAddressBody), TestWebhook);
webhookRouter.get("/deliveries", GetWebhookDeliveries);
webhookRouter.get("/health", GetWebhookHealth);
webhookRouter.get("/dead-letters", GetWebhookDeadLetters);
webhookRouter.post("/dead-letters/:id/replay", ReplayWebhookDeadLetter);
// Replay console: static event catalog, wallet-scoped replay queue,
// and a side-effect-free envelope preview.
webhookRouter.get("/replay/events", GetWebhookReplayEvents);
webhookRouter.get("/replay/queue", GetWebhookReplayQueue);
webhookRouter.post("/replay/preview", validatePreviewWebhookEvent, PreviewWebhookReplay);
