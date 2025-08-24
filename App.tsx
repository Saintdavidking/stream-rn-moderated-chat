import React, { useEffect, useState, useCallback, useRef } from 'react';
import { SafeAreaView, Text, TextInput, View, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Chat, ChannelList, Channel, MessageList, MessageInput, OverlayProvider } from 'stream-chat-react-native';
import { StreamChat } from 'stream-chat';

// Must be reachable by the app (device/emulator). Use your public URL if on device/emulator.
const backend = 'http://localhost:5050';

export default function App() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeChannel, setActiveChannel] = useState<any>(null);

  // one StreamChat instance at a time
  const clientRef = useRef<StreamChat | null>(null);

  const disconnectClient = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    try {
      c.off?.();
      await c.disconnectUser();
    } catch {}
    clientRef.current = null;
  }, []);

  // Boot per selected user
  useEffect(() => {
    let mounted = true;

    async function boot() {
      if (!selectedUserId) return;

      setBootError(null);
      setReady(false);
      setActiveChannel(null);

      await disconnectClient(); // ensure previous user is fully disconnected

      try {
        const tokenResp = await fetch(`${backend}/token?user_id=${encodeURIComponent(selectedUserId)}`);
        if (!tokenResp.ok) throw new Error(`/token failed: ${tokenResp.status}`);
        const { apiKey, token } = await tokenResp.json();

        const client = StreamChat.getInstance(apiKey);
        clientRef.current = client;

        await client.connectUser(
          {
            id: selectedUserId,
            name: selectedUserId,
            image: `https://getstream.io/random_png/?id=${selectedUserId}&name=${selectedUserId}`,
          },
          token
        );

        // ensure demo channel exists
        const chResp = await fetch(`${backend}/channel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: 'demo-general', members: ['alice', 'bob', 'charlie'] }),
        });
        if (!chResp.ok) throw new Error(`/channel failed: ${chResp.status} ${await chResp.text()}`);

        const anyMessaging = await client.queryChannels({ type: 'messaging' }, { last_message_at: -1 }, { limit: 5 });
        if (!mounted) return;

        if (anyMessaging.length > 0) setActiveChannel(anyMessaging[0]);
        setReady(true);
      } catch (e: any) {
        if (mounted) { setBootError(e?.message ?? String(e)); setReady(false); }
      }
    }

    boot();

    return () => {
      mounted = false;
      disconnectClient();
    };
  }, [selectedUserId, disconnectClient]);

  const onSend = useCallback(
    async (message: any) => {
      try {
        if (!activeChannel) throw new Error('No active channel');
        await activeChannel.sendMessage(message);
      } catch (e: any) {
        Alert.alert('Send failed', e?.message ?? 'Message rejected by moderation rules.');
      }
    },
    [activeChannel]
  );

  if (!selectedUserId) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.loginWrap}>
          <Text style={styles.title}>Choose a user</Text>
          <View style={styles.row}>
            {['alice', 'bob', 'charlie'].map(u => (
              <TouchableOpacity key={u} style={styles.userBtn} onPress={() => setSelectedUserId(u)}>
                <Text style={styles.userBtnText}>{u}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.subtitle}>…or enter a custom userId</Text>
          <UserInput onSubmit={val => setSelectedUserId(val.trim())} />
        </View>
      </SafeAreaView>
    );
  }

  if (bootError) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 16 }}>
        <Text style={{ fontWeight: '600', marginBottom: 8 }}>Boot error for "{selectedUserId}":</Text>
        <Text style={{ color: 'crimson', marginBottom: 16 }}>{bootError}</Text>
        <TouchableOpacity style={styles.logoutBtn} onPress={() => setSelectedUserId(null)}>
          <Text style={styles.logoutText}>Back to Login</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!ready || !clientRef.current) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 16 }}>
        <Text>Starting chat as "{selectedUserId}"…</Text>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Key the overlay and chat to force a clean remount when user changes */}
      <OverlayProvider key={`overlay-${selectedUserId}`}>
        <SafeAreaView style={{ flex: 1 }}>
          <Chat client={clientRef.current!} key={`chat-${selectedUserId}`}>
            {activeChannel ? (
              <Channel channel={activeChannel} key={activeChannel.cid}>
                <MessageList
                  // Load older messages earlier while scrolling up
                  additionalFlatListProps={{ onEndReachedThreshold: 0.4 }}
                />
                <MessageInput onSend={onSend} />
              </Channel>
            ) : (
              <ChannelList
                filters={{ type: 'messaging' }}
                sort={{ last_message_at: -1 }}
                onSelect={(ch) => setActiveChannel(ch)}
              />
            )}
          </Chat>
          <View style={styles.footer}>
            <TouchableOpacity
              onPress={async () => {
                setReady(false);
                setActiveChannel(null);
                await disconnectClient();
                setSelectedUserId(null);
              }}
            >
              <Text style={styles.logoutSmall}>Switch user</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </OverlayProvider>
    </GestureHandlerRootView>
  );
}

function UserInput({ onSubmit }: { onSubmit: (val: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <View style={{ width: '100%', maxWidth: 320 }}>
      <TextInput
        value={val}
        onChangeText={setVal}
        placeholder="e.g. dave"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <TouchableOpacity
        style={[styles.userBtn, { marginTop: 12, alignSelf: 'flex-start' }]}
        onPress={() => val.trim() && onSubmit(val)}
      >
        <Text style={styles.userBtnText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  loginWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { marginTop: 8, opacity: 0.7 },
  row: { flexDirection: 'row', gap: 12 },
  userBtn: { backgroundColor: '#2b6cb0', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  userBtnText: { color: 'white', fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#cbd5e0', padding: 10, borderRadius: 8, backgroundColor: 'white' },
  footer: { padding: 10, alignItems: 'center' },
  logoutBtn: { backgroundColor: '#2b6cb0', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignSelf: 'flex-start' },
  logoutText: { color: 'white', fontWeight: '600' },
  logoutSmall: { color: '#2b6cb0', fontWeight: '600' },
});
