import { useState, html, sb } from "./common.js";

function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return html`<div class="center"><form class="card login" onSubmit=${async (e) => {
    e.preventDefault(); setErr(""); setBusy(true);
    const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } });
    setBusy(false); error ? setErr(error.message) : setSent(true);
  }}>
    <div class="logo">TV</div>
    <h2>Event Expenses</h2>
    <div class="mute sm" style="margin-bottom:18px">For The Vanity Portrait Studio team. Enter your <b>@thevanityportraitstudio.com</b> address and we'll email you a one-tap sign-in link. No password.</div>
    ${sent ? html`<div class="note blue"><b>Check your inbox.</b> Open the email on this device and tap the link; it brings you back here signed in. The link works once and expires in an hour.</div>`
      : html`<div><input type="email" required autoFocus placeholder="you@thevanityportraitstudio.com" value=${email} onInput=${(e) => setEmail(e.target.value)} style="width:100%;margin-bottom:10px"/>
             <button class="btn" style="width:100%" disabled=${busy}>${busy ? "Sending…" : "Email me a sign-in link"}</button></div>`}
    ${err && html`<div class="note red" style="margin-top:10px">${err}</div>`}
  </form></div>`;
}

export { Login };
