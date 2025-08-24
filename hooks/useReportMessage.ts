// src/hooks/useReportMessage.ts
import { useCallback } from 'react';
import { useChatContext } from 'stream-chat-react-native';

/**
 * useReportMessage
 * Returns a function you can call with a message ID to flag it for review.
 * Uses the Stream client from context; no globals needed.
 */
export function useReportMessage() {
  const { client } = useChatContext();

  return useCallback(
    async (messageId: string) => {
      try {
        await client.flagMessage(messageId, 'user-report');
        alert('Thanks for the report. Our moderators will review it.');
      } catch (e: any) {
        alert(e?.message ?? 'Could not report message.');
      }
    },
    [client]
  );
}
