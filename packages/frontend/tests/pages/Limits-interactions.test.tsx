import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ agentName: "test-agent" }),
  A: (props: any) => <a href={props.href}>{props.children}</a>,
}));

vi.mock("@solidjs/meta", () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

let mockRules: any[] = [];
let mockRoutingStatus = { enabled: false };

vi.mock("../../src/services/api.js", () => ({
  getNotificationRules: vi.fn(() => Promise.resolve(mockRules)),
  getNotificationLogs: vi.fn(() => Promise.resolve([])),
  createNotificationRule: vi.fn(() => Promise.resolve({})),
  updateNotificationRule: vi.fn(() => Promise.resolve({})),
  deleteNotificationRule: vi.fn(() => Promise.resolve({})),
  getEmailProvider: vi.fn(() => Promise.resolve(null)),
  removeEmailProvider: vi.fn(() => Promise.resolve({})),
  getRoutingStatus: vi.fn(() => Promise.resolve(mockRoutingStatus)),
}));

vi.mock("../../src/services/setup-status.js", () => ({
  checkIsSelfHosted: vi.fn(() => Promise.resolve(false)),
  checkEmailConfigured: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../src/services/toast-store.js", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/components/LimitRuleModal.js", () => ({
  default: (props: any) => (
    <div data-testid="limit-modal" data-open={props.open}>
      <button data-testid="mock-save" onClick={() => props.onSave({ metric_type: "tokens", threshold: 100, period: "day", action: "notify" })}>
        Save
      </button>
    </div>
  ),
}));

vi.mock("../../src/components/CloudEmailInfo.js", () => ({
  default: (props: any) => (
    <div data-testid="cloud-email-info">CloudEmailInfo: {props.email}</div>
  ),
}));

vi.mock("../../src/services/auth-client.js", () => ({
  authClient: {
    useSession: () => () => ({ data: { user: { email: "user@example.com" } } }),
  },
}));

import Limits from "../../src/pages/Limits";

describe("Limits page interactions", () => {
  beforeEach(() => {
    mockRules = [];
    mockRoutingStatus = { enabled: false };
    vi.clearAllMocks();
  });

  it("calls createNotificationRule and shows toast on save", async () => {
    const { createNotificationRule } = await import("../../src/services/api.js");
    const { toast } = await import("../../src/services/toast-store.js");

    render(() => <Limits />);
    fireEvent.click(screen.getByText("Create rule"));
    fireEvent.click(screen.getByTestId("mock-save"));

    await vi.waitFor(() => {
      expect(createNotificationRule).toHaveBeenCalledWith(expect.objectContaining({
        agent_name: "test-agent",
        metric_type: "tokens",
        threshold: 100,
      }));
      expect(toast.success).toHaveBeenCalledWith("Rule created");
    });
  });

  it("calls deleteNotificationRule via kebab menu and confirmation modal", async () => {
    const { deleteNotificationRule } = await import("../../src/services/api.js");
    const { toast } = await import("../../src/services/toast-store.js");
    mockRules = [{
      id: "r1", agent_name: "test-agent", metric_type: "tokens",
      threshold: 50000, period: "day", action: "notify",
      is_active: true, trigger_count: 0, created_at: "2026-01-01",
    }];

    render(() => <Limits />);

    // Open kebab menu
    await vi.waitFor(() => {
      expect(screen.getByLabelText("Rule options")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Rule options"));

    // Click Delete in dropdown
    await vi.waitFor(() => {
      expect(screen.getByText("Delete")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Delete"));

    // Confirm deletion: check the checkbox then click Delete rule
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-modal__confirm-row")).not.toBeNull();
    });

    const checkbox = document.querySelector('.confirm-modal__confirm-row input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    const deleteBtn = document.querySelector(".btn--danger") as HTMLButtonElement;
    fireEvent.click(deleteBtn);

    await vi.waitFor(() => {
      expect(deleteNotificationRule).toHaveBeenCalledWith("r1");
      expect(toast.success).toHaveBeenCalledWith("Rule deleted");
    });
  });

  it("closes kebab menu when clicking the same kebab button again", async () => {
    mockRules = [{
      id: "r1", agent_name: "test-agent", metric_type: "tokens",
      threshold: 50000, period: "day", action: "notify",
      is_active: true, trigger_count: 0, created_at: "2026-01-01",
    }];

    render(() => <Limits />);

    await vi.waitFor(() => {
      expect(screen.getByLabelText("Rule options")).toBeDefined();
    });

    // First click opens menu
    fireEvent.click(screen.getByLabelText("Rule options"));
    await vi.waitFor(() => {
      expect(document.querySelector(".rule-menu__dropdown")).not.toBeNull();
    });

    // Second click on same button closes menu
    fireEvent.click(screen.getByLabelText("Rule options"));
    await vi.waitFor(() => {
      expect(document.querySelector(".rule-menu__dropdown")).toBeNull();
    });
  });

  it("calls updateNotificationRule when saving an edited rule", async () => {
    const { updateNotificationRule } = await import("../../src/services/api.js");
    const { toast } = await import("../../src/services/toast-store.js");
    mockRules = [{
      id: "r1", agent_name: "test-agent", metric_type: "tokens",
      threshold: 50000, period: "day", action: "notify",
      is_active: true, trigger_count: 0, created_at: "2026-01-01",
    }];

    render(() => <Limits />);

    // Open kebab menu and click Edit
    await vi.waitFor(() => {
      expect(screen.getByLabelText("Rule options")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Rule options"));
    await vi.waitFor(() => expect(screen.getByText("Edit")).toBeDefined());
    fireEvent.click(screen.getByText("Edit"));

    // Now editRule is set — clicking save should call updateNotificationRule
    await vi.waitFor(() => {
      expect(screen.getByTestId("limit-modal").getAttribute("data-open")).toBe("true");
    });
    fireEvent.click(screen.getByTestId("mock-save"));

    await vi.waitFor(() => {
      expect(updateNotificationRule).toHaveBeenCalledWith("r1", expect.objectContaining({
        metric_type: "tokens",
        threshold: 100,
      }));
      expect(toast.success).toHaveBeenCalledWith("Rule updated");
    });
  });

  it("handles error in handleSave gracefully", async () => {
    const { createNotificationRule } = await import("../../src/services/api.js");
    (createNotificationRule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));

    render(() => <Limits />);
    fireEvent.click(screen.getByText("Create rule"));
    fireEvent.click(screen.getByTestId("mock-save"));

    // Should not throw — error is caught
    await vi.waitFor(() => {
      expect(createNotificationRule).toHaveBeenCalled();
    });
  });

  it("handles error in handleDelete gracefully", async () => {
    const { deleteNotificationRule } = await import("../../src/services/api.js");
    (deleteNotificationRule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));
    mockRules = [{
      id: "r1", agent_name: "test-agent", metric_type: "tokens",
      threshold: 50000, period: "day", action: "notify",
      is_active: true, trigger_count: 0, created_at: "2026-01-01",
    }];

    render(() => <Limits />);

    await vi.waitFor(() => {
      expect(screen.getByLabelText("Rule options")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Rule options"));
    await vi.waitFor(() => expect(screen.getByText("Delete")).toBeDefined());
    fireEvent.click(screen.getByText("Delete"));

    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-modal__confirm-row")).not.toBeNull();
    });

    const checkbox = document.querySelector('.confirm-modal__confirm-row input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    const deleteBtn = document.querySelector(".btn--danger") as HTMLButtonElement;
    fireEvent.click(deleteBtn);

    // Should not throw — error is caught
    await vi.waitFor(() => {
      expect(deleteNotificationRule).toHaveBeenCalledWith("r1");
    });
  });

  it("disables delete button and shows Deleting... during deletion", async () => {
    let resolveDelete: () => void;
    const { deleteNotificationRule } = await import("../../src/services/api.js");
    (deleteNotificationRule as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((r) => { resolveDelete = r; }),
    );
    mockRules = [{
      id: "r1", agent_name: "test-agent", metric_type: "tokens",
      threshold: 50000, period: "day", action: "notify",
      is_active: true, trigger_count: 0, created_at: "2026-01-01",
    }];

    render(() => <Limits />);

    await vi.waitFor(() => {
      expect(screen.getByLabelText("Rule options")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Rule options"));
    await vi.waitFor(() => expect(screen.getByText("Delete")).toBeDefined());
    fireEvent.click(screen.getByText("Delete"));

    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-modal__confirm-row")).not.toBeNull();
    });

    const checkbox = document.querySelector('.confirm-modal__confirm-row input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    const deleteBtn = document.querySelector(".btn--danger") as HTMLButtonElement;
    fireEvent.click(deleteBtn);

    await vi.waitFor(() => {
      expect(deleteBtn.querySelector(".spinner")).not.toBeNull();
      expect(deleteBtn.disabled).toBe(true);
    });

    resolveDelete!();
    await vi.waitFor(() => {
      expect(deleteBtn.textContent).toBe("Delete rule");
    });
  });

});
