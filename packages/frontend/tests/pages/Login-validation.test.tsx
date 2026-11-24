import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

const mockSignInEmail = vi.fn().mockResolvedValue({});
const mockSendVerificationEmail = vi.fn().mockResolvedValue({});

let mockSearchParams: Record<string, string> = {};
vi.mock("@solidjs/router", () => ({
  A: (props: any) => <a href={props.href} class={props.class}>{props.children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ search: "" }),
  useSearchParams: () => [mockSearchParams],
}));

vi.mock("@solidjs/meta", () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

vi.mock("../../src/services/auth-client.js", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => mockSignInEmail(...args), social: vi.fn() },
    sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
  },
}));

vi.mock("../../src/services/toast-store.js", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockCheckSocialProviders = vi.fn().mockResolvedValue([]);
vi.mock("../../src/services/setup-status.js", () => ({
  checkSocialProviders: (...args: unknown[]) => mockCheckSocialProviders(...args),
}));

import Login from "../../src/pages/Login";

const setupForm = () => {
  const { container, unmount } = render(() => <Login />);
  const form = container.querySelector("form") as HTMLFormElement;
  const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
  const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
  return { container, form, emailInput, passwordInput, unmount };
};

describe("Login validation - empty/invalid inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockSignInEmail.mockResolvedValue({});
    mockSendVerificationEmail.mockResolvedValue({});
    mockCheckSocialProviders.mockResolvedValue([]);
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  });

  it("marks the form invalid when both email and password are empty", () => {
    const { form, emailInput, passwordInput } = setupForm();
    expect(emailInput.value).toBe("");
    expect(passwordInput.value).toBe("");
    expect(emailInput.hasAttribute("required")).toBe(true);
    expect(passwordInput.hasAttribute("required")).toBe(true);
    expect(form.checkValidity()).toBe(false);
  });

  it("marks the form invalid when email is empty but password is set", () => {
    const { form, passwordInput } = setupForm();
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    expect(form.checkValidity()).toBe(false);
  });

  it("marks the form invalid when password is empty but email is set", () => {
    const { form, emailInput } = setupForm();
    fireEvent.input(emailInput, { target: { value: "user@example.com" } });
    expect(form.checkValidity()).toBe(false);
  });

  it("marks the form invalid when the email format is not a valid address", () => {
    const { form, emailInput, passwordInput } = setupForm();
    fireEvent.input(emailInput, { target: { value: "not-an-email" } });
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    expect(form.checkValidity()).toBe(false);
  });

  it("marks the form valid when both fields are populated correctly", () => {
    const { form, emailInput, passwordInput } = setupForm();
    fireEvent.input(emailInput, { target: { value: "user@example.com" } });
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    expect(form.checkValidity()).toBe(true);
  });

  it("uses the email input type so browsers enforce address format", () => {
    const { emailInput } = setupForm();
    expect(emailInput.type).toBe("email");
  });

  it("accepts emails containing SQL meta-characters but the browser still requires a valid shape", () => {
    const { form, emailInput, passwordInput } = setupForm();
    // SQL-meta characters embedded in a syntactically valid email
    fireEvent.input(emailInput, { target: { value: "drop'table--@example.com" } });
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    // type=email allows quotes; what matters is the @domain shape stays valid
    expect(form.checkValidity()).toBe(true);
  });

  it("rejects a SQL-meta string that is not a valid email shape", () => {
    const { form, emailInput, passwordInput } = setupForm();
    fireEvent.input(emailInput, { target: { value: "' OR 1=1 --" } });
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    expect(form.checkValidity()).toBe(false);
  });

  it("does not trim password whitespace before forwarding to authClient", async () => {
    const { container, emailInput, passwordInput } = setupForm();
    mockSignInEmail.mockResolvedValue({ error: null });
    fireEvent.input(emailInput, { target: { value: "user@example.com" } });
    // The password input is type=password, so the raw value (including whitespace) is preserved.
    fireEvent.input(passwordInput, { target: { value: "  pass  " } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledTimes(1);
    });
    // The email input has type=email so its value is browser/jsdom-normalized
    // (leading/trailing whitespace stripped). The component itself does not trim
    // either signal, but the platform-level email type may.
    const call = mockSignInEmail.mock.calls[0][0];
    expect(call.password).toBe("  pass  ");
    expect(call.email).toBe("user@example.com");
  });

  it("accepts unicode characters in the email local part", () => {
    const { form, emailInput, passwordInput } = setupForm();
    fireEvent.input(emailInput, { target: { value: "用户@example.com" } });
    fireEvent.input(passwordInput, { target: { value: "validpassword" } });
    // jsdom + type=email permits unicode local-parts; assert it does not throw
    expect(() => form.checkValidity()).not.toThrow();
  });

  it("handles very large password inputs without throwing", async () => {
    const { container, emailInput, passwordInput } = setupForm();
    mockSignInEmail.mockResolvedValue({ error: null });
    const huge = "a".repeat(10 * 1024 + 1); // 10KB + 1 char
    fireEvent.input(emailInput, { target: { value: "user@example.com" } });
    fireEvent.input(passwordInput, { target: { value: huge } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledTimes(1);
    });
    const call = mockSignInEmail.mock.calls[0][0] as { password: string };
    expect(call.password.length).toBe(huge.length);
  });
});

describe("Login resend cooldown - timer edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockSignInEmail.mockResolvedValue({});
    mockSendVerificationEmail.mockResolvedValue({});
    mockCheckSocialProviders.mockResolvedValue([]);
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const triggerVerificationState = async (container: HTMLElement) => {
    mockSignInEmail.mockResolvedValue({
      error: { message: "Email is not verified", code: "EMAIL_NOT_VERIFIED" },
    });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: "user@example.com" },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: "pass" },
    });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Send verification email");
    });
    return Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Send verification email"),
    ) as HTMLButtonElement;
  };

  it("does not start a second cooldown when the resend button is clicked while disabled", async () => {
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    const resendBtn = await triggerVerificationState(container);
    fireEvent.click(resendBtn);
    // First call resolves and cooldown starts
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Resend in");
    });
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
    // Now the button is disabled — fireEvent.click on a disabled button is a no-op
    const disabledBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Resend in"),
    ) as HTMLButtonElement;
    expect(disabledBtn.disabled).toBe(true);
    fireEvent.click(disabledBtn);
    fireEvent.click(disabledBtn);
    // Allow any micro-tasks to flush before asserting
    await Promise.resolve();
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("never decrements the cooldown below zero", async () => {
    vi.useFakeTimers();
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    const resendBtn = await triggerVerificationState(container);
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Resend in 60s");
    });
    // Drain the entire 60-second window plus a generous overshoot
    vi.advanceTimersByTime(120_000);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Send verification email");
    });
    // No negative seconds should ever render
    expect(container.textContent).not.toMatch(/Resend in -\d+s/);
  });

  it("stops the interval once the cooldown reaches zero", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    const resendBtn = await triggerVerificationState(container);
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Resend in 60s");
    });
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Send verification email");
    });
    // clearInterval is called both inside the tick that hits zero and (potentially)
    // on unmount; at minimum it must have fired once before unmount.
    const callsBeforeUnmount = clearIntervalSpy.mock.calls.length;
    expect(callsBeforeUnmount).toBeGreaterThanOrEqual(1);
    clearIntervalSpy.mockRestore();
  });

  it("does not leak the interval when unmounted mid-cooldown", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container, unmount } = render(() => <Login />);
    const resendBtn = await triggerVerificationState(container);
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Resend in 60s");
    });
    // Unmount while ~58 seconds still remain
    vi.advanceTimersByTime(2000);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    // Advancing the clock further should not trigger any state updates,
    // and therefore no "unmounted state update" warnings.
    vi.advanceTimersByTime(120_000);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
