import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

let mockSearchParamsValue: Record<string, string> = {};
const mockRequestPasswordReset = vi.fn();
const mockResetPassword = vi.fn();
const mockCheckEmailConfigured = vi.fn().mockResolvedValue(true);

vi.mock("@solidjs/router", () => ({
  A: (props: any) => <a href={props.href} class={props.class}>{props.children}</a>,
  useSearchParams: () => [new Proxy({}, { get: (_, key) => mockSearchParamsValue[key as string] })],
}));

vi.mock("@solidjs/meta", () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

vi.mock("../../src/services/auth-client.js", () => ({
  authClient: {
    requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
    resetPassword: (...args: unknown[]) => mockResetPassword(...args),
  },
}));

vi.mock("../../src/services/setup-status.js", () => ({
  checkEmailConfigured: (...args: unknown[]) => mockCheckEmailConfigured(...args),
}));

import ResetPassword from "../../src/pages/ResetPassword";

describe("ResetPassword - Request form (no token)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEmailConfigured.mockResolvedValue(true);
    mockSearchParamsValue = {};
  });

  it("renders reset password heading", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Reset your password")).toBeDefined();
  });

  it("shows email input for request form", () => {
    render(() => <ResetPassword />);
    expect(screen.getByPlaceholderText("you@example.com")).toBeDefined();
  });

  it("shows send reset link button", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Send reset link")).toBeDefined();
  });

  it("shows back to sign in link", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Back to sign in")).toBeDefined();
  });

  it("shows subtitle text", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Enter your email to receive a reset link")).toBeDefined();
  });

  it("email input is required", () => {
    const { container } = render(() => <ResetPassword />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    expect(emailInput.required).toBe(true);
  });

  it("back to sign in link points to /login", () => {
    const { container } = render(() => <ResetPassword />);
    const link = container.querySelector('a[href="/login"]');
    expect(link).not.toBeNull();
  });

  it("submits email and shows confirmation", async () => {
    mockRequestPasswordReset.mockResolvedValue({ error: null });
    const { container } = render(() => <ResetPassword />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.input(emailInput, { target: { value: "test@test.com" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Check your email for a reset link");
    });
  });

  it("shows error on failed request", async () => {
    mockRequestPasswordReset.mockResolvedValue({ error: { message: "User not found" } });
    const { container } = render(() => <ResetPassword />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.input(emailInput, { target: { value: "unknown@test.com" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("User not found");
    });
  });

  it("shows loading state during submission", async () => {
    mockRequestPasswordReset.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <ResetPassword />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.input(emailInput, { target: { value: "test@test.com" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(btn.querySelector(".spinner")).not.toBeNull();
    });
  });
});

describe("ResetPassword - Request form (no email provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEmailConfigured.mockResolvedValue(false);
    mockSearchParamsValue = {};
  });

  it("shows the unavailable notice instead of the form", async () => {
    const { container } = render(() => <ResetPassword />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Password reset by email isn't available on this install",
      );
    });
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });

  it("swaps the subtitle to explain email is not set up", async () => {
    const { container } = render(() => <ResetPassword />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Email isn't set up on this server");
    });
  });

  it("links to the Account page for a signed-in change-password path", async () => {
    const { container } = render(() => <ResetPassword />);
    await vi.waitFor(() => {
      expect(container.querySelector('a[href="/account"]')).not.toBeNull();
    });
  });
});

describe("ResetPassword - Set new password form (with token)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEmailConfigured.mockResolvedValue(true);
    mockSearchParamsValue = { token: "test-token-123" };
  });

  it("renders set new password heading", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Set new password")).toBeDefined();
  });

  it("shows password and confirm password inputs", () => {
    render(() => <ResetPassword />);
    expect(screen.getByPlaceholderText("Enter new password")).toBeDefined();
    expect(screen.getByPlaceholderText("Confirm new password")).toBeDefined();
  });

  it("shows reset password button", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Reset password")).toBeDefined();
  });

  it("shows subtitle about entering new password", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Enter your new password")).toBeDefined();
  });

  it("password inputs have min length", () => {
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    expect((inputs[0] as HTMLInputElement).minLength).toBe(8);
    expect((inputs[1] as HTMLInputElement).minLength).toBe(8);
  });

  it("shows error when passwords do not match", async () => {
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "password123" } });
    fireEvent.input(inputs[1], { target: { value: "different456" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Passwords do not match");
    });
  });

  it("calls resetPassword on successful submit", async () => {
    mockResetPassword.mockResolvedValue({ error: null });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith({
        newPassword: "newpass123",
        token: "test-token-123",
      });
    });
  });

  it("shows success state after password reset", async () => {
    mockResetPassword.mockResolvedValue({ error: null });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Your password has been updated");
    });
  });

  it("shows error on failed reset", async () => {
    mockResetPassword.mockResolvedValue({ error: { message: "Token expired" } });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Token expired");
    });
  });

  it("shows loading state during reset", async () => {
    mockResetPassword.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(btn.querySelector(".spinner")).not.toBeNull();
    });
  });

  it("shows back to sign in link with token", () => {
    render(() => <ResetPassword />);
    expect(screen.getByText("Back to sign in")).toBeDefined();
  });

  it("renders RequestResetForm when token is empty string", () => {
    mockSearchParamsValue = { token: "" };
    render(() => <ResetPassword />);
    expect(screen.getByPlaceholderText("you@example.com")).toBeDefined();
    expect(screen.getByText("Reset your password")).toBeDefined();
    expect(screen.queryByText("Set new password")).toBeNull();
  });

  it("renders RequestResetForm when token is undefined", () => {
    mockSearchParamsValue = {};
    render(() => <ResetPassword />);
    expect(screen.getByPlaceholderText("you@example.com")).toBeDefined();
    expect(screen.getByText("Reset your password")).toBeDefined();
    expect(screen.queryByText("Set new password")).toBeNull();
  });

  it("form remains interactive after API error", async () => {
    mockResetPassword.mockResolvedValue({ error: { message: "Token invalid" } });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Token invalid");
    });
    const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector(".spinner")).toBeNull();
    // Form is still rendered and can be re-submitted
    expect(container.querySelector("form")).not.toBeNull();
    mockResetPassword.mockResolvedValue({ error: null });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledTimes(2);
    });
  });
});

describe("ResetPassword - Invalid/malformed token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsValue = { token: "not-a-valid-uuid" };
  });

  it("shows error when token is malformed", async () => {
    mockResetPassword.mockResolvedValue({
      error: { message: "Token is invalid or expired" },
    });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Token is invalid or expired");
    });
    expect(mockResetPassword).toHaveBeenCalledWith({
      newPassword: "newpass123",
      token: "not-a-valid-uuid",
    });
  });

  it("form recovers after token expiry mid-request (race condition)", async () => {
    // Race: user submits, token expires server-side, API rejects mid-request
    mockResetPassword.mockResolvedValue({
      error: { message: "Token expired" },
    });
    const { container } = render(() => <ResetPassword />);
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.input(inputs[0], { target: { value: "newpass123" } });
    fireEvent.input(inputs[1], { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector("form")!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Token expired");
    });
    // Button is re-enabled and spinner is gone so the user can retry
    const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector(".spinner")).toBeNull();
    // Form fields are still mounted and editable
    const inputsAfter = container.querySelectorAll('input[type="password"]');
    expect(inputsAfter.length).toBe(2);
    expect((inputsAfter[0] as HTMLInputElement).value).toBe("newpass123");
  });
});
