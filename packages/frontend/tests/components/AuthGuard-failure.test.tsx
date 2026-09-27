import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";

const mockNavigate = vi.fn();

vi.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: "/overview", search: "" }),
}));

vi.mock("../../src/services/auth-client.js", () => ({
  authClient: {
    useSession: () => () => mockSessionData,
  },
}));

let mockSessionData: any = { data: null, isPending: false };

import AuthGuard from "../../src/components/AuthGuard";

describe("AuthGuard failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionData = { data: null, isPending: false, refetch: async () => {} };
  });

  it("navigates to login when session is not authenticated", async () => {
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/login?redirect=%2Foverview", { replace: true });
    });
  });
});
