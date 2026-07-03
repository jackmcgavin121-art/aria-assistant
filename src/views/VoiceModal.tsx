import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import { Modal } from "../components/Modal";
import { sendMessage } from "../features/chat";
import { addTask } from "../features/tasks";
import { completeOnce } from "../api/anthropic";
import { speak, stopSpeaking } from "../lib/tts";
import { markdownToText } from "../lib/markdown";

// Speech recognition is feature-detected: Chromium's engine is not available
// inside Electron, so this degrades honestly instead of pretending to listen.
function getRecognition(): (new () => any) | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return !!getRecognition();
}

export function VoiceModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"ptt" | "meeting" | "handsfree">("ptt");
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [hasWhisperKey, setHasWhisperKey] = useState(false);
  const [hfPhase, setHfPhase] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const recRef = useRef<any>(null);
  const mediaRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null);
  const hfActive = useRef(false);
  const toast = useStore((s) => s.toast);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const supported = speechSupported();

  useEffect(() => {
    void window.aria.secrets.has("openaiApiKey").then(setHasWhisperKey);
    return () => {
      hfActive.current = false;
      stopSpeaking();
      recRef.current?.stop?.();
      mediaRef.current?.rec.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Whisper path: record the mic, transcribe on stop (used when the browser
  // speech engine is unavailable — i.e. inside the desktop shell).
  const startWhisper = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: "audio/webm" });
        if (blob.size < 2000) return; // too short to contain speech
        setTranscribing(true);
        const res = await window.aria.stt.transcribe(await blob.arrayBuffer(), "audio/webm");
        setTranscribing(false);
        if (res.ok) setTranscript((t) => (t + " " + res.text).trim());
        else toast(res.error, "err");
      };
      mediaRef.current = { rec, chunks };
      rec.start();
      setListening(true);
    } catch (e: any) {
      toast("Microphone unavailable: " + e.message, "err");
    }
  };
  const stopWhisper = () => mediaRef.current?.rec.state !== "inactive" && mediaRef.current?.rec.stop();

  const start = () => {
    const Rec = getRecognition();
    if (!Rec) return;
    const rec = new Rec();
    rec.continuous = mode === "meeting";
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e: any) => {
      let final = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript + " ";
      }
      if (final) setTranscript((t) => (t + " " + final).trim());
    };
    rec.onerror = (e: any) => {
      toast("Speech recognition error: " + e.error, "err");
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stop = () => {
    recRef.current?.stop?.();
    setListening(false);
  };

  /* ------- hands-free loop: listen → send → speak reply → listen again ------- */

  const hfStop = () => {
    hfActive.current = false;
    stopSpeaking();
    recRef.current?.stop?.();
    if (mediaRef.current?.rec.state !== "inactive") mediaRef.current?.rec.stop();
    setHfPhase("idle");
  };

  const hfHandle = async (text: string) => {
    if (!text.trim() || !hfActive.current) return;
    setTranscript(text.trim());
    setHfPhase("thinking");
    await sendMessage(text.trim());
    if (!hfActive.current) return;
    const st = useStore.getState();
    const list = st.activeConvId ? st.messages[st.activeConvId] ?? [] : [];
    const last = list[list.length - 1];
    const reply = last?.role === "assistant" ? markdownToText(last.content) : "";
    if (reply) {
      setHfPhase("speaking");
      speak(reply, st.settings.ttsVoice, st.settings.ttsRate, () => {
        if (hfActive.current) hfListen();
      });
    } else {
      hfListen();
    }
  };

  const hfListen = () => {
    if (!hfActive.current) return;
    setHfPhase("listening");
    if (supported) {
      // Browser engine: ends on silence by itself — fully hands-free.
      const Rec = getRecognition()!;
      const rec = new Rec();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = navigator.language || "en-US";
      rec.onresult = (e: any) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
        void hfHandle(text);
      };
      rec.onerror = () => hfStop();
      recRef.current = rec;
      rec.start();
    } else {
      // Whisper path has no silence detection: talk, then press "Done talking".
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
          const chunks: Blob[] = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          rec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            if (!hfActive.current) return;
            const blob = new Blob(chunks, { type: "audio/webm" });
            if (blob.size < 2000) {
              hfListen();
              return;
            }
            setHfPhase("thinking");
            const res = await window.aria.stt.transcribe(await blob.arrayBuffer(), "audio/webm");
            if (res.ok) void hfHandle(res.text);
            else {
              toast(res.error, "err");
              hfStop();
            }
          };
          mediaRef.current = { rec, chunks };
          rec.start();
        } catch (e: any) {
          toast("Microphone unavailable: " + e.message, "err");
          hfStop();
        }
      })();
    }
  };

  const hfStart = () => {
    if (!hasApiKey) {
      toast("Add your Anthropic API key in Settings first.", "err");
      return;
    }
    hfActive.current = true;
    hfListen();
  };

  const extractActions = async () => {
    if (!transcript.trim() || !hasApiKey) return;
    setExtracting(true);
    const res = await completeOnce({
      model: useStore.getState().model,
      maxTokens: 800,
      system: "You extract action items from meeting transcripts.",
      messages: [{ role: "user", content: `Extract the action items from this transcript as a plain list, one per line, no bullets or numbering. If there are none, reply "NONE".\n\n${transcript}` }],
    });
    setExtracting(false);
    if (!res.ok) {
      toast(res.error, "err");
      return;
    }
    const items = res.text.split("\n").map((l) => l.trim()).filter((l) => l && l !== "NONE");
    if (!items.length) {
      toast("No action items found", "info");
      return;
    }
    items.forEach((t) => addTask({ title: t }));
    toast(`Added ${items.length} tasks from the transcript`, "ok");
  };

  return (
    <Modal
      title="Voice"
      onClose={() => { stop(); hfStop(); onClose(); }}
      wide
      footer={
        transcript.trim() && mode !== "handsfree" ? (
          <>
            <button className="btn" onClick={() => { navigator.clipboard.writeText(transcript); toast("Copied", "ok"); }}>⧉ Copy</button>
            {mode === "meeting" && <button className="btn" disabled={extracting || !hasApiKey} onClick={() => void extractActions()}>{extracting ? "Extracting…" : "☑ Extract action items"}</button>}
            <button className="btn primary" onClick={() => { void sendMessage(transcript.trim()); onClose(); }}>Send to chat →</button>
          </>
        ) : undefined
      }
    >
      {!supported && !hasWhisperKey ? (
        <div style={{ padding: 12 }}>
          <p style={{ lineHeight: 1.6 }}>
            🎤 <b>Dictation needs one quick setup step.</b> The browser speech engine isn't available inside this
            desktop shell, so ARIA can instead record your microphone and transcribe with Whisper.
          </p>
          <p className="hint" style={{ lineHeight: 1.6 }}>
            Add an OpenAI API key in <b>Settings → Voice</b> to enable it. Alternatively, Windows' built-in dictation
            works in any ARIA text box — press <span className="kbd">Win</span>+<span className="kbd">H</span>.
            Text-to-speech (the 🔊 button on messages) works regardless.
          </p>
          <button className="btn primary" onClick={() => { onClose(); useStore.setState({ settingsOpen: true, settingsTab: "voice" }); }}>Open voice settings</button>
        </div>
      ) : (
        <div>
          <div className="tabs">
            <button className={"tab" + (mode === "ptt" ? " on" : "")} onClick={() => { stop(); stopWhisper(); hfStop(); setMode("ptt"); }}>🎙 Push to talk</button>
            <button className={"tab" + (mode === "meeting" ? " on" : "")} onClick={() => { stop(); stopWhisper(); hfStop(); setMode("meeting"); }}>📼 Meeting mode</button>
            <button className={"tab" + (mode === "handsfree" ? " on" : "")} onClick={() => { stop(); stopWhisper(); setMode("handsfree"); }}>🔁 Hands-free</button>
          </div>
          {mode === "handsfree" ? (
            <div style={{ textAlign: "center", padding: 12 }}>
              {hfPhase === "idle" && (
                <>
                  <button className="btn primary" onClick={hfStart}>🔁 Start hands-free conversation</button>
                  <p className="hint" style={{ marginTop: 8, maxWidth: 420, marginInline: "auto" }}>
                    Talk to ARIA out loud: your speech is sent to the active conversation and the reply is read back,
                    then the mic reopens.
                    {!supported && " (Whisper mode: press “Done talking” after each turn — it has no silence detection.)"}
                  </p>
                </>
              )}
              {hfPhase === "listening" && (
                <>
                  <div className="big" style={{ fontSize: 32 }}>🎙</div>
                  <p>Listening{supported ? "… (pauses end your turn)" : "…"}</p>
                  {!supported && (
                    <button className="btn primary" onClick={() => mediaRef.current?.rec.state !== "inactive" && mediaRef.current?.rec.stop()}>
                      ✅ Done talking
                    </button>
                  )}
                  <button className="btn danger sm" style={{ marginLeft: 8 }} onClick={hfStop}>■ End</button>
                </>
              )}
              {hfPhase === "thinking" && (
                <>
                  <div className="big" style={{ fontSize: 32 }}>💭</div>
                  <p>Thinking…</p>
                  <button className="btn danger sm" onClick={hfStop}>■ End</button>
                </>
              )}
              {hfPhase === "speaking" && (
                <>
                  <div className="big" style={{ fontSize: 32 }}>🔊</div>
                  <p>Speaking…</p>
                  <button className="btn sm" onClick={() => { stopSpeaking(); hfListen(); }}>⏭ Skip to listening</button>
                  <button className="btn danger sm" style={{ marginLeft: 8 }} onClick={hfStop}>■ End</button>
                </>
              )}
              {transcript && <p className="hint" style={{ marginTop: 10 }}>Last heard: “{transcript.slice(0, 140)}”</p>}
            </div>
          ) : (
            <>
              <div style={{ textAlign: "center", padding: 12 }}>
                <button
                  className={"btn " + (listening ? "danger" : "primary")}
                  disabled={transcribing}
                  onClick={supported ? (listening ? stop : start) : listening ? stopWhisper : () => void startWhisper()}
                >
                  {transcribing ? "Transcribing…" : listening ? "■ Stop" : mode === "ptt" ? "🎙 Start dictating" : "📼 Start recording"}
                </button>
                {listening && <p className="hint" style={{ marginTop: 8 }}>{supported ? "Listening…" : "Recording… (transcribed when you stop)"}</p>}
                {!supported && <p className="hint" style={{ marginTop: 4 }}>Using Whisper transcription</p>}
              </div>
              <textarea className="ta" rows={8} placeholder="Transcript appears here…" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
