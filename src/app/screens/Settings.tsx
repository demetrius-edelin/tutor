import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ModelCheckView, SettingsInput, SettingsValues, SettingsView } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { Spinner } from "../components/Spinner";

// The providers of the main model and of the video model. src/config.ts has the same names.
interface ProviderInfo {
  id: string;
  name: string;
  // The page of the provider that makes an API key.
  keyPage: { url: string; name: string };
  modelNote: string;
}

const KEY_PAGES = {
  anthropic: { url: "https://console.anthropic.com/settings/keys", name: "the Anthropic Console" },
  openai: { url: "https://platform.openai.com/api-keys", name: "the OpenAI Platform" },
  openrouter: { url: "https://openrouter.ai/keys", name: "OpenRouter" },
  google: { url: "https://aistudio.google.com/apikey", name: "Google AI Studio" },
};

const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", keyPage: KEY_PAGES.anthropic, modelNote: "Type the name exactly as Anthropic writes it, for example claude-haiku-5-5." },
  { id: "openai", name: "OpenAI", keyPage: KEY_PAGES.openai, modelNote: "Type the name exactly as OpenAI writes it, for example gpt-6-luna." },
  {
    id: "openrouter",
    name: "OpenRouter",
    keyPage: KEY_PAGES.openrouter,
    modelNote: "Use the form vendor/model. Copy the name from the model page on openrouter.ai.",
  },
  {
    id: "google",
    name: "Google Gemini API",
    keyPage: KEY_PAGES.google,
    modelNote: "Type the name with no prefix, exactly as Google writes it, for example gemini-3.8-flash.",
  },
];

// Only Gemini models read YouTube videos: through OpenRouter, or through the Gemini API of Google.
const VIDEO_PROVIDERS: ProviderInfo[] = [
  { id: "openrouter", name: "OpenRouter", keyPage: KEY_PAGES.openrouter, modelNote: "A Gemini model in the form google/model, for example google/gemini-3.8-flash." },
  { id: "google", name: "Google Gemini API", keyPage: KEY_PAGES.google, modelNote: "A Gemini model with no prefix, for example gemini-3.8-flash." },
];

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function Settings() {
  const settings = useApi<SettingsView>("/api/settings");
  return (
    <Layout>
      {settings.state === "loading" && <p className="quiet">Loading the settings.</p>}
      {settings.state === "error" && (
        <Notice title="The settings did not load">
          <p>{settings.message}</p>
        </Notice>
      )}
      {settings.state === "ready" && <SettingsForm initial={settings.data} />}
    </Layout>
  );
}

function SettingsForm({ initial }: { initial: SettingsView }) {
  // The view of the last save. The form compares its values with it.
  const [view, setView] = useState(initial);
  const [values, setValues] = useState<SettingsValues>(initial.values);
  // The new API keys that the user typed. The server never sends a full key back.
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    (Object.keys(values) as (keyof SettingsValues)[]).some((name) => values[name] !== view.values[name]) ||
    Object.values(keys).some((key) => key.trim() !== "");
  const provider = PROVIDERS.find((item) => item.id === values.provider);
  const videoProvider = VIDEO_PROVIDERS.find((item) => item.id === values.videoProvider);

  const update = (name: keyof SettingsValues) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setValues({ ...values, [name]: event.target.value });
    setSaved(false);
  };
  const updateKey = (id: string) => (event: ChangeEvent<HTMLInputElement>) => {
    setKeys({ ...keys, [id]: event.target.value });
    setSaved(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await postJson<SettingsView>("/api/settings", { ...values, keys } satisfies SettingsInput);
      setView(next);
      setValues(next.values);
      setKeys({});
      setSaved(true);
    } catch (problem) {
      setError((problem as Error).message);
    }
    setSaving(false);
  };

  return (
    <>
      <h1>Settings</h1>
      <p className="lead">
        The tutor uses a large language model (LLM) to read your books, to teach, and to test. Select the model, and type the API key from
        your provider. The provider charges you for each request.
      </p>

      <div className="run-note settings-status" aria-live="polite">
        <p>
          <span className="settings-label">Model:</span>{" "}
          {view.model ?? <span className="error">{view.modelError}</span>}
        </p>
        <p>
          <span className="settings-label">Video model:</span>{" "}
          {view.videoModel ?? (view.videoError ? <span className="error">{view.videoError}</span> : <span className="quiet">none</span>)}
        </p>
        {view.model && <CheckModel key={view.model} changed={changed} />}
      </div>

      <form className="settings-form" onSubmit={save}>
        <h2>Model</h2>
        <Field id="provider" label="Provider">
          <select id="provider" value={values.provider} onChange={update("provider")}>
            <option value="">Select a provider</option>
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {provider && (
          <>
            <KeyField provider={provider} end={view.keys[provider.id] ?? null} value={keys[provider.id] ?? ""} onChange={updateKey(provider.id)} />
            <Field id="model" label="Model name" note={provider.modelNote}>
              <input id="model" type="text" spellCheck={false} autoComplete="off" value={values.model} onChange={update("model")} />
            </Field>
            <Field
              id="reasoning"
              label="Reasoning level"
              note="A higher level can give better results, but each request is slower. Each model accepts only some levels."
            >
              <select id="reasoning" value={values.reasoning} onChange={update("reasoning")}>
                <option value="">The default of the model</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
            {provider.id === "openrouter" && (
              <Field
                id="openrouter-providers"
                label="OpenRouter providers"
                optional
                note="The providers that can serve the model, in order, with commas between them, for example deepinfra, together. Leave it empty to let OpenRouter select."
              >
                <input
                  id="openrouter-providers"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={values.openrouterProviders}
                  onChange={update("openrouterProviders")}
                />
              </Field>
            )}
          </>
        )}

        <h2>Video model</h2>
        <p className="quiet">
          Only YouTube videos need a video model. It must be a Gemini model, because only Gemini models read YouTube videos. One OpenRouter key or
          one Gemini key serves the model and the video model.
        </p>
        <Field
          id="video-provider"
          label="Video provider"
          note={videoProvider && videoProvider.id === provider?.id ? "The video model uses the API key of the model above." : undefined}
        >
          <select id="video-provider" value={values.videoProvider} onChange={update("videoProvider")}>
            <option value="">No video model</option>
            {VIDEO_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {videoProvider && (
          <>
            {videoProvider.id !== provider?.id && (
              <KeyField
                provider={videoProvider}
                end={view.keys[videoProvider.id] ?? null}
                value={keys[videoProvider.id] ?? ""}
                onChange={updateKey(videoProvider.id)}
              />
            )}
            <Field id="video-model" label="Video model name" note={videoProvider.modelNote}>
              <input id="video-model" type="text" spellCheck={false} autoComplete="off" value={values.videoModel} onChange={update("videoModel")} />
            </Field>
          </>
        )}

        <p className="button-row">
          <button className="button" type="submit" disabled={saving || !changed}>
            {saving && <Spinner />}
            {saving ? "Saving" : "Save"}
          </button>
          {saved && !changed && <span className="quiet">The tutor saved the settings.</span>}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
      {view.canStop && <StopTutor />}
      <p className="quiet small settings-file">
        The tutor keeps these values in the file {view.file}. The commands in the terminal read the same file.
      </p>
    </>
  );
}

function Field({ id, label, optional, note, children }: { id: string; label: string; optional?: boolean; note?: string | undefined; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional && <span className="quiet"> (optional)</span>}
      </label>
      {children}
      {note && <p className="field-note">{note}</p>}
    </div>
  );
}

// The key field is empty. The note tells if a key is set, and shows its last 4 characters.
function KeyField({
  provider,
  end,
  value,
  onChange,
}: {
  provider: ProviderInfo;
  end: string | null;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = `key-${provider.id}`;
  const status = end === null ? "No key is set." : `A key is set${end ? `. It ends with ${end}` : ""}. Type a new key only to change it.`;
  return (
    <div className="field">
      <label htmlFor={id}>API key for {provider.name}</label>
      <input id={id} type="password" spellCheck={false} autoComplete="off" value={value} onChange={onChange} />
      <p className="field-note">
        {status}{" "}
        <a href={provider.keyPage.url} target="_blank" rel="noreferrer">
          Get a key from {provider.keyPage.name}
        </a>
      </p>
    </div>
  );
}

// The tutor from a download has no terminal window on macOS, so the settings page can stop it.
function StopTutor() {
  const [state, setState] = useState<"running" | "stopping" | "stopped">("running");
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setState("stopping");
    setError(null);
    try {
      await postJson("/api/stop");
      setState("stopped");
    } catch (problem) {
      setError((problem as Error).message);
      setState("running");
    }
  };
  return (
    <section className="settings-stop" aria-live="polite">
      <h2>Stop the tutor</h2>
      {state === "stopped" ? (
        <p>The tutor stopped. You can close this page. To start the tutor again, open it in the same way as before.</p>
      ) : (
        <>
          <p className="quiet">The tutor runs until you stop it or turn off the computer. If a run is in progress, the run also stops.</p>
          <p className="button-row">
            <button className="button secondary" type="button" onClick={stop} disabled={state === "stopping"}>
              {state === "stopping" && <Spinner />}
              {state === "stopping" ? "Stopping the tutor" : "Stop the tutor"}
            </button>
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// One small request to the saved model. It costs very little, and it shows that the key and the model name work.
function CheckModel({ changed }: { changed: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const answer = await postJson<ModelCheckView>("/api/settings/check");
      setResult({ ok: true, text: `The model answered in ${answer.seconds} s. It works.` });
    } catch (problem) {
      setResult({ ok: false, text: (problem as Error).message });
    }
    setBusy(false);
  };
  return (
    <>
      <p className="button-row">
        <button className="button secondary small" type="button" onClick={check} disabled={busy || changed}>
          {busy && <Spinner />}
          {busy ? "Testing the model" : "Test the model"}
        </button>
        {changed && <span className="quiet small">Save the changes first.</span>}
      </p>
      {result && <p className={result.ok ? undefined : "error"}>{result.text}</p>}
    </>
  );
}
