import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import { Modal } from "../components/Modal";
import { sendMessage } from "../features/chat";
import { addTask } from "../features/tasks";
import { completeOnce } from "../api/anthropic";

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
  const [mode, setMode] = useState<"ptt" | "meeting">("ptt");
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [hasWhisperKey, setHasWhisperKey] = useState(false);
  const recRef = useRef<any>(null);
  const mediaRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null);
  const toast = useStore((s) => s.toast);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const supported = speechSupported();

  useEffect(() => {
    void window.aria.secrets.has("openaiApiKey").then(setHasWhisperKey);
    return () => {
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
      onClose={() => { stop(); onClose(); }}
      wide
      footer={
        transcript.trim() ? (
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
            <button className={"tab" + (mode === "ptt" ? " on" : "")} onClick={() => { stop(); stopWhisper(); setMode("ptt"); }}>🎙 Push to talk</button>
            <button className={"tab" + (mode === "meeting" ? " on" : "")} onClick={() => { stop(); stopWhisper(); setMode("meeting"); }}>📼 Meeting mode</button>
          </div>
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
        </div>
      )}
    </Modal>
  );
}
