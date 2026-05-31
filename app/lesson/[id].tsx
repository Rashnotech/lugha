import { Lesson } from "@/types/learning";
import { useAuth, useUser } from "@clerk/expo";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import {
  Call,
  CallClosedCaption,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
  useCallStateHooks,
} from "@stream-io/video-react-native-sdk";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { images } from "@/constants/images";
import { colors } from "@/constants/theme";
import { LESSONS } from "@/data/lessons";
import { useLanguageStore } from "@/store/languageStore";

type CallStatus = "idle" | "connecting" | "joined" | "error";
type AgentStatus = "idle" | "connecting" | "connected" | "failed";

const AGENT_USER_ID = "ai-teacher";

export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const { selectedLanguage } = useLanguageStore();

  const lesson = LESSONS.find((l) => l.id === id);

  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");

  const callRef = useRef<Call | null>(null);
  const clientRef = useRef<StreamVideoClient | null>(null);
  const agentSessionRef = useRef<string | null>(null);
  const lessonStartTimeRef = useRef<number | null>(null);
  const abandonedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !user || !lesson) return;

    lessonStartTimeRef.current = Date.now();
    abandonedRef.current = false;

    startCall();

    return () => {
      if (!abandonedRef.current) {
        abandonedRef.current = true;
      }
      callRef.current?.leave().catch(console.error);
      clientRef.current?.disconnectUser().catch(console.error);
      stopAgentSession(callRef.current?.id ?? null, agentSessionRef.current);
    };
  }, [isLoaded, user, lesson]);

  async function startCall() {
    if (!user || !lesson) return;
    setCallStatus("connecting");

    try {
      const clerkToken = await getToken();
      if (!clerkToken) throw new Error("Not authenticated");
      const res = await fetch("/api/stream-token", {
        headers: { Authorization: `Bearer ${clerkToken}` },
      });
      if (!res.ok) throw new Error("Token fetch failed");
      const { token, apiKey } = await res.json();

      const streamClient = StreamVideoClient.getOrCreateInstance({
        apiKey,
        token,
        user: {
          id: user.id,
          name: user.fullName ?? user.id,
          image: user.imageUrl || undefined,
        },
      });

      const callId = `lesson-${lesson.id}-${user.id}`;
      const streamCall = streamClient.call("default", callId);
      await streamCall.join({ create: true });

      // Mute mic initially
      try {
        await streamCall.microphone.disable();
      } catch {}

      const language = selectedLanguage ?? (lesson.id.split("-")[0] as string);
      try {
        await streamCall.update({
          custom: {
            lesson_id: lesson.id,
            lesson_title: lesson.title,
            language,
            goals: lesson.goals.map((g) => g.description),
            vocabulary: lesson.vocabulary.map(
              (v) => `${v.word}: ${v.translation}`,
            ),
            phrases: lesson.phrases.map((p) => p.text),
            topics: lesson.aiTeacherPrompt.topics,
            system_prompt: lesson.aiTeacherPrompt.systemPrompt,
            intro_message: lesson.aiTeacherPrompt.introMessage,
          },
        });
      } catch (updateErr) {
        console.warn(
          "[lesson] call.update failed:",
          updateErr,
        );
      }

      try {
        await streamCall.startClosedCaptions();
      } catch (e) {
        console.warn("[lesson] startClosedCaptions failed:", e);
      }

      callRef.current = streamCall;
      clientRef.current = streamClient;
      setClient(streamClient);
      setCall(streamCall);
      setCallStatus("joined");

      startAgentSession(callId);
    } catch (err) {
      console.error("Stream call error:", err);
      setCallStatus("error");
    }
  }

  async function startAgentSession(callId: string) {
    setAgentStatus("connecting");
    try {
      const res = await fetch("/api/agent-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, callType: "default" }),
      });
      if (res.ok) {
        const { session_id } = await res.json();
        agentSessionRef.current = session_id ?? null;
        setAgentStatus("connected");
      } else {
        setAgentStatus("failed");
      }
    } catch (err) {
      setAgentStatus("failed");
    }
  }

  function stopAgentSession(callId: string | null, sessionId: string | null) {
    if (!callId || !sessionId) return;
    fetch(
      `/api/agent-session?callId=${encodeURIComponent(callId)}&sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  async function handleLeave() {
    if (!abandonedRef.current) {
      abandonedRef.current = true;
    }
    const callId = callRef.current?.id ?? null;
    const sessionId = agentSessionRef.current;
    try {
      await callRef.current?.leave();
      clientRef.current?.disconnectUser();
    } catch {}
    callRef.current = null;
    clientRef.current = null;
    agentSessionRef.current = null;
    stopAgentSession(callId, sessionId);
    router.back();
  }

  if (!lesson) {
    return (
      <SafeAreaView className="flex-1 bg-neutral-background">
        <View className="flex-1 items-center justify-center">
          <Text className="font-poppins-regular text-sm text-neutral-textSecondary">
            Lesson not found
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const displayStatus = getDisplayStatus(callStatus, agentStatus);

  return (
    <SafeAreaView className="flex-1 bg-[#F9FAFB]">
      {/* Header */}
      <View className="flex-row items-center justify-between px-6 pt-4 pb-4">
        <View className="flex-row items-center gap-4">
          <TouchableOpacity onPress={handleLeave} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color="#0F172A" />
          </TouchableOpacity>
          <View>
            <Text className="font-poppins-semibold text-lg text-[#0F172A]">AI Teacher</Text>
            <View className="flex-row items-center gap-1.5 mt-0.5">
              <View className={`w-2 h-2 rounded-full`} style={{ backgroundColor: displayStatus.color }} />
              <Text className="font-poppins-medium text-xs" style={{ color: displayStatus.color }}>
                {displayStatus.label}
              </Text>
            </View>
          </View>
        </View>

        <View className="flex-row items-center gap-3">
          <View className="w-9 h-9 rounded-full border border-gray-200 items-center justify-center bg-white shadow-sm">
            <Ionicons name="videocam-outline" size={18} color="#0F172A" />
          </View>
          <View className="w-9 h-9 rounded-full border border-gray-200 items-center justify-center bg-white shadow-sm">
            <Text className="font-poppins-semibold text-sm text-[#0F172A]">12</Text>
          </View>
          <View className="w-9 h-9 rounded-full border border-gray-200 items-center justify-center bg-white shadow-sm overflow-hidden">
            {user?.imageUrl ? (
               <Image source={{ uri: user.imageUrl }} style={{ width: 36, height: 36 }} />
            ) : (
               <Ionicons name="person-outline" size={18} color="#0F172A" />
            )}
          </View>
        </View>
      </View>

      {/* Main Content Area */}
      {callStatus === "joined" && client && call ? (
        <StreamVideo client={client}>
          <StreamCall call={call}>
            <ActiveCallContent
              agentStatus={agentStatus}
              lesson={lesson}
              call={call}
              onRetry={() => startAgentSession(call.id)}
              onEndCall={handleLeave}
              userImage={user?.imageUrl}
            />
          </StreamCall>
        </StreamVideo>
      ) : (
        <View className="flex-1 px-4 pb-4">
          <View className="flex-1 rounded-[32px] overflow-hidden bg-white shadow-sm border border-gray-100 items-center justify-center">
            <Image source={images.room} style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.3 }} contentFit="cover" blurRadius={10} />
            <Image source={images.mascotWelcome} style={{ width: 220, height: 220, opacity: 0.8 }} contentFit="contain" />
            
            <View className="mt-8 bg-white/90 px-6 py-4 rounded-2xl shadow-sm">
              {callStatus === "connecting" ? (
                <View className="flex-row items-center gap-3">
                  <ActivityIndicator color={colors.primary.purple} />
                  <Text className="font-poppins-medium text-[#0F172A]">Connecting to lesson...</Text>
                </View>
              ) : callStatus === "error" ? (
                <View className="items-center">
                  <Text className="font-poppins-medium text-[#EF4444] mb-3">Connection failed</Text>
                  <TouchableOpacity className="bg-lingua-purple px-6 py-3 rounded-full" onPress={startCall}>
                    <Text className="text-white font-poppins-semibold">Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text className="font-poppins-medium text-[#64748B]">Starting...</Text>
              )}
            </View>
          </View>
          
          <FeedbackRow />
        </View>
      )}
    </SafeAreaView>
  );
}

type PartialCaption = { speaker: "agent" | "user"; text: string };

function ActiveCallContent({
  agentStatus,
  lesson,
  call,
  onRetry,
  onEndCall,
  userImage
}: {
  agentStatus: AgentStatus;
  lesson: Lesson;
  call: Call;
  onRetry: () => void;
  onEndCall: () => void;
  userImage?: string;
}) {
  const { useMicrophoneState, useCallClosedCaptions } = useCallStateHooks();
  const { microphone } = useMicrophoneState();
  const captions = useCallClosedCaptions();
  
  const [micEnabled, setMicEnabled] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);

  const [partial, setPartial] = useState<PartialCaption | null>(null);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  interface StreamCustomEvent {
    custom?: {
      type?: string;
      speaker?: "agent" | "user";
      text?: string;
    };
  }

  useEffect(() => {
    const unsubscribe = call.on("custom", (event: StreamCustomEvent) => {
      const data = event?.custom ?? {};
      if (data.type === "transcript_partial" && data.text) {
        setPartial({ speaker: data.speaker ?? "agent", text: data.text });
        if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
        partialTimerRef.current = setTimeout(() => setPartial(null), 3000);
      }
    });
    return () => {
      unsubscribe();
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
    };
  }, [call]);

  useEffect(() => {
    if (captions.length > 0) {
      setPartial(null);
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
    }
  }, [captions]);

  const isReady = agentStatus === "connected";

  const toggleMic = () => {
    if (!isReady) return;
    if (micEnabled) {
      microphone.disable();
      setMicEnabled(false);
    } else {
      microphone.enable();
      setMicEnabled(true);
    }
  };

  // Find the latest caption to show in the bubble
  let latestCaption = null;
  if (partial) {
     latestCaption = partial;
  } else if (captions.length > 0) {
     const cap = captions[captions.length - 1];
     latestCaption = { speaker: cap.user?.id === AGENT_USER_ID ? "agent" : "user", text: cap.text };
  }

  // Determine if it's the teacher speaking. If no one is speaking, we might just show a default message.
  const isTeacherSpeaking = latestCaption?.speaker === "agent";

  return (
    <View className="flex-1 px-4 pb-4">
      {/* Background Room Image Card */}
      <View className="flex-1 rounded-[32px] overflow-hidden bg-white shadow-sm border border-gray-100 relative">
        <Image source={images.room} style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.8 }} contentFit="cover" />
        
        {/* User Mini Preview */}
        <View className="absolute top-4 right-4 w-20 h-[100px] rounded-2xl overflow-hidden border-[3px] border-white bg-gray-200 shadow-sm z-10">
           {userImage ? (
             <Image source={{ uri: userImage }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
           ) : (
             <View className="flex-1 items-center justify-center">
                <Ionicons name="person" size={40} color="#9CA3AF" />
             </View>
           )}
        </View>

        {/* Mascot & Bubble Container */}
        <View className="flex-1 items-center justify-center mt-[-40px]">
           <Image source={images.mascotWelcome} style={{ width: 260, height: 260 }} contentFit="contain" />
           
           {/* Speech Bubble */}
           {showSubtitles && (
             <View className="h-32 justify-start w-full items-center px-6">
                {(isTeacherSpeaking && latestCaption) ? (
                  <View className="bg-white rounded-[20px] p-4 mt-2 shadow-sm relative w-full flex-row items-center justify-between min-h-[80px]">
                     {/* Tail */}
                     <View className="absolute -top-3 left-[20%] w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-b-[14px] border-b-white" />
                     <View className="flex-1 mr-4">
                       <Text className="font-poppins-semibold text-[#0F172A] text-[16px] leading-[24px]">
                         {latestCaption.text}
                       </Text>
                     </View>
                     <Ionicons name="volume-high" size={26} color={colors.primary.purple} />
                  </View>
                ) : (!isReady) ? (
                  <View className="bg-white/90 rounded-[20px] p-4 mt-2 shadow-sm w-[80%] items-center justify-center">
                    {agentStatus === "connecting" ? (
                      <View className="flex-row items-center gap-2">
                        <ActivityIndicator color={colors.primary.purple} />
                        <Text className="font-poppins-medium text-[#0F172A]">Teacher joining...</Text>
                      </View>
                    ) : agentStatus === "failed" ? (
                      <TouchableOpacity onPress={onRetry} className="items-center">
                         <Text className="font-poppins-medium text-[#EF4444]">Agent unavailable</Text>
                         <Text className="font-poppins-regular text-xs text-[#64748B] mt-1">Tap to retry</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : null}
             </View>
           )}
        </View>

        {/* Bottom Controls */}
        <View className="absolute bottom-8 left-0 right-0 flex-row justify-center items-start gap-4 px-4 z-10">
           {/* Camera */}
           <View className="items-center w-[70px]">
             <TouchableOpacity className="w-16 h-16 rounded-full bg-white items-center justify-center shadow-md">
               <Ionicons name="videocam" size={26} color="#1E3A8A" />
             </TouchableOpacity>
             <Text className="font-poppins-medium text-white text-[11px] mt-2 shadow-sm text-center">Camera</Text>
           </View>
           {/* Mic */}
           <View className="items-center w-[70px]">
             <TouchableOpacity onPress={toggleMic} className={`w-16 h-16 rounded-full items-center justify-center shadow-md ${!micEnabled ? 'bg-white' : 'bg-gray-100'}`}>
               <Ionicons name={micEnabled ? "mic" : "mic-off"} size={26} color="#1E3A8A" />
             </TouchableOpacity>
             <Text className="font-poppins-medium text-white text-[11px] mt-2 shadow-sm text-center">Mic</Text>
           </View>
           {/* Subtitles */}
           <View className="items-center w-[70px]">
             <TouchableOpacity onPress={() => setShowSubtitles(!showSubtitles)} className={`w-16 h-16 rounded-full items-center justify-center shadow-md ${showSubtitles ? 'bg-white' : 'bg-white opacity-70'}`}>
               <MaterialIcons name="subtitles" size={26} color="#1E3A8A" />
             </TouchableOpacity>
             <Text className="font-poppins-medium text-white text-[11px] mt-2 shadow-sm text-center">Subtitles</Text>
           </View>
           {/* End Call */}
           <View className="items-center w-[70px]">
             <TouchableOpacity onPress={onEndCall} className="w-16 h-16 rounded-full bg-[#EF4444] items-center justify-center shadow-md">
               <Ionicons name="call" size={26} color="#FFFFFF" style={{ transform: [{ rotate: "135deg" }] }} />
             </TouchableOpacity>
             <Text className="font-poppins-medium text-white text-[11px] mt-2 shadow-sm text-center">End Call</Text>
           </View>
        </View>
        
        {/* Gradient Overlay for controls visibility */}
        <View className="absolute bottom-0 left-0 right-0 h-40 bg-black/20 pointer-events-none" />
      </View>
      
      {/* Feedback Row */}
      <FeedbackRow />
    </View>
  );
}

function FeedbackRow() {
  return (
    <View className="flex-row items-center justify-between bg-white rounded-[24px] mt-4 px-6 py-5 shadow-sm border border-gray-100">
      <View className="items-center flex-1">
        <Text className="font-poppins-semibold text-[13px] text-[#0F172A] mb-1">Speaking</Text>
        <Text className="font-poppins-medium text-[13px] text-[#22C55E]">Excellent</Text>
      </View>
      <View className="w-px h-10 bg-gray-200" />
      <View className="items-center flex-1">
        <Text className="font-poppins-semibold text-[13px] text-[#0F172A] mb-1">Pronunciation</Text>
        <Text className="font-poppins-medium text-[13px] text-[#3B82F6]">Great</Text>
      </View>
      <View className="w-px h-10 bg-gray-200" />
      <View className="items-center flex-1">
        <Text className="font-poppins-semibold text-[13px] text-[#0F172A] mb-1">Grammar</Text>
        <Text className="font-poppins-medium text-[13px] text-[#8B5CF6]">Good</Text>
      </View>
    </View>
  );
}

function getDisplayStatus(
  callStatus: CallStatus,
  agentStatus: AgentStatus,
): { color: string; label: string } {
  if (callStatus === "joined") {
    const map: Record<AgentStatus, { color: string; label: string }> = {
      idle: { color: colors.neutral.textSecondary, label: "Setting up..." },
      connecting: {
        color: colors.semantic.warning,
        label: "Joining lesson...",
      },
      connected: { color: "#22C55E", label: "Online" },
      failed: { color: colors.semantic.error, label: "Agent unavailable" },
    };
    return map[agentStatus];
  }
  const map: Record<CallStatus, { color: string; label: string }> = {
    idle: { color: colors.neutral.textSecondary, label: "Starting..." },
    connecting: { color: colors.semantic.warning, label: "Connecting..." },
    joined: { color: "#22C55E", label: "Online" },
    error: { color: colors.semantic.error, label: "Connection failed" },
  };
  return map[callStatus];
}
