import * as pubsub from "../pubsub.js";
import type { Command } from "./shared.js";

export const pubsubCommands: Record<string, Command> = {
  // SUBSCRIBE channel [channel ...] -> one ["subscribe", channel, count] reply
  // per channel, where count is how many channels this client is now on.
  SUBSCRIBE: {
    arity: -2,
    run: (channels, client) => ({
      sequence: channels.map((channel) => {
        pubsub.subscribe(client, channel);
        return ["subscribe", channel, client.subscriptions.size];
      }),
    }),
  },

  // UNSUBSCRIBE [channel ...] -> one ["unsubscribe", channel, count] reply per
  // channel. With no channels, leaves all of them.
  UNSUBSCRIBE: {
    arity: -1,
    run: (channels, client) => {
      const leaving = channels.length > 0 ? channels : [...client.subscriptions];
      if (leaving.length === 0) return { sequence: [["unsubscribe", null, 0]] }; // wasn't subscribed to anything
      return {
        sequence: leaving.map((channel) => {
          pubsub.unsubscribe(client, channel);
          return ["unsubscribe", channel, client.subscriptions.size];
        }),
      };
    },
  },

  // PUBLISH channel message -> how many clients received it
  PUBLISH: { arity: 3, run: ([channel, message]) => pubsub.publish(channel, message) },
};
