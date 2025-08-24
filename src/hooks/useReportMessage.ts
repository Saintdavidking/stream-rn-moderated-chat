import { useCallback } from 'react';
import { useChatContext } from 'stream-chat-react-native';

/**
 * Hook to flag (report) a message.
 * Uses the Stream client from context so no globals are needed.
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
