import mongoose from "mongoose";

/**
 * A contract event that could not be delivered to a subscriber's webhook
 * after every retry was exhausted (issue #97). Unlike WebhookDelivery
 * (an append-only log of individual HTTP attempts), this stores the full
 * undelivered payload so it can be inspected or manually replayed later —
 * without it, an event that outlives all retries is only ever visible as a
 * handful of "failed" WebhookDelivery rows and its actual data is lost.
 */
const webhookDeadLetterSchema = new mongoose.Schema(
  {
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WebhookSubscription",
      required: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    attempts: {
      type: Number,
      required: true,
    },
    lastError: {
      type: String,
      default: null,
    },
    lastStatusCode: {
      type: Number,
      default: null,
    },
    resolved: {
      type: Boolean,
      default: false,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    /** How many times an operator has replayed this event. Replay history for
     * the replay console; not part of the original #97 dead-letter shape. */
    replayCount: {
      type: Number,
      default: 0,
    },
    lastReplayedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

const WebhookDeadLetter =
  mongoose.models.WebhookDeadLetter ||
  mongoose.model("WebhookDeadLetter", webhookDeadLetterSchema);

export default WebhookDeadLetter;
