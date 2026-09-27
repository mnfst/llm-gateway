import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const mockCreateCustomProvider = vi.fn();
const mockUpdateCustomProvider = vi.fn();
const mockDeleteCustomProvider = vi.fn();
const mockProbeCustomProvider = vi.fn();
const mockCheckIsSelfHosted = vi.fn().mockResolvedValue(false);

vi.mock("../../src/services/api.js", () => ({
  createCustomProvider: (...args: unknown[]) => mockCreateCustomProvider(...args),
  updateCustomProvider: (...args: unknown[]) => mockUpdateCustomProvider(...args),
  deleteCustomProvider: (...args: unknown[]) => mockDeleteCustomProvider(...args),
  probeCustomProvider: (...args: unknown[]) => mockProbeCustomProvider(...args),
}));

vi.mock("../../src/services/setup-status.js", () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

vi.mock("../../src/services/toast-store.js", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import CustomProviderForm from "../../src/components/CustomProviderForm";
import { toast } from "../../src/services/toast-store.js";

describe("CustomProviderForm", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCustomProvider.mockResolvedValue({
      id: "cp-1",
      name: "Groq",
      base_url: "https://api.groq.com/openai/v1",
      api_kind: "openai",
      has_api_key: true,
      models: [{ model_name: "llama-3.1-70b" }],
      created_at: "2026-03-04T00:00:00Z",
    });
    mockUpdateCustomProvider.mockResolvedValue({
      id: "cp-1",
      name: "Updated Groq",
      base_url: "https://api.groq.com/openai/v1",
      api_kind: "openai",
      has_api_key: true,
      models: [{ model_name: "llama-3.1-70b" }],
      created_at: "2026-03-04T00:00:00Z",
    });
    mockDeleteCustomProvider.mockResolvedValue({ ok: true });
  });

  it("renders the form fields", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    expect(screen.getByPlaceholderText("e.g. Groq, Together, Azure")).toBeDefined();
    expect(screen.getByPlaceholderText("https://api.example.com/v1")).toBeDefined();
    expect(screen.getByPlaceholderText("sk-...")).toBeDefined();
    expect(screen.getByPlaceholderText("Model name")).toBeDefined();
  });

  it("Create button is disabled when required fields are empty", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    const createBtn = screen.getByText("Connect");
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables Create button when required fields are filled", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    const nameInput = screen.getByPlaceholderText("e.g. Groq, Together, Azure");
    const urlInput = screen.getByPlaceholderText("https://api.example.com/v1");
    const modelInput = screen.getByPlaceholderText("Model name");

    fireEvent.input(nameInput, { target: { value: "Groq" } });
    fireEvent.input(urlInput, { target: { value: "https://api.groq.com/v1" } });
    fireEvent.input(modelInput, { target: { value: "llama-3.1-70b" } });

    await waitFor(() => {
      expect(screen.getByText("Connect").hasAttribute("disabled")).toBe(false);
    });
  });

  it("calls createCustomProvider and onCreated on submit", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Groq" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [{ model_name: "llama-3.1-70b" }],
      });
      expect(toast.success).toHaveBeenCalledWith("Groq connected");
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it("calls onBack when back button is clicked", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    fireEvent.click(screen.getByLabelText("Back to providers"));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows error message on API failure", async () => {
    mockCreateCustomProvider.mockRejectedValue(new Error("Name already exists"));

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Groq" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Name already exists")).toBeDefined();
    });
  });

  it("submits with API key when provided", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Groq" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), {
      target: { value: "gsk_test123" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/v1",
        api_kind: "openai",
        apiKey: "gsk_test123",
        models: [{ model_name: "llama-3.1-70b" }],
      });
    });
  });

  it("submits with pricing fields when provided", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Groq" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });
    fireEvent.input(screen.getByPlaceholderText("$/M in"), {
      target: { value: "0.59" },
    });
    fireEvent.input(screen.getByPlaceholderText("$/M out"), {
      target: { value: "0.79" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [
          {
            model_name: "llama-3.1-70b",
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
        ],
      });
    });
  });

  it("converts comma decimal separators to dots in pricing fields", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Groq" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });
    fireEvent.input(screen.getByPlaceholderText("$/M in"), {
      target: { value: "0,59" },
    });
    fireEvent.input(screen.getByPlaceholderText("$/M out"), {
      target: { value: "0,79" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [
          {
            model_name: "llama-3.1-70b",
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
        ],
      });
    });
  });

  it("shows generic error message for non-Error exceptions", async () => {
    mockCreateCustomProvider.mockRejectedValue("string error");

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Test" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "model" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Failed to create provider")).toBeDefined();
    });
  });

  it("clears error when name input changes", async () => {
    mockCreateCustomProvider.mockRejectedValue(new Error("Some error"));

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Test" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "model" },
    });

    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("Some error")).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "New Name" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Some error")).toBeNull();
    });
  });

  it("clears error when base URL input changes", async () => {
    mockCreateCustomProvider.mockRejectedValue(new Error("URL error"));

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Test" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "model" },
    });

    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("URL error")).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://localhost:8000" },
    });
    await waitFor(() => {
      expect(screen.queryByText("URL error")).toBeNull();
    });
  });

  it("remove button is disabled when only one model row exists", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    const removeBtn = screen.getByLabelText("Remove model 1");
    expect(removeBtn.hasAttribute("disabled")).toBe(true);
  });

  it("does not remove last model row when clicking remove", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const removeBtn = screen.getByLabelText("Remove model 1");
    fireEvent.click(removeBtn);

    expect(screen.getAllByPlaceholderText("Model name")).toHaveLength(1);
  });

  it("shows Creating... text while submitting", async () => {
    let resolveSubmit: (v: unknown) => void;
    mockCreateCustomProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Test" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "model" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      const btn = document.querySelector("button.btn--primary") as HTMLButtonElement;
      expect(btn.querySelector(".spinner")).not.toBeNull();
    });

    resolveSubmit!({
      id: "cp-1",
      name: "Test",
      base_url: "https://api.example.com/v1",
      has_api_key: false,
      models: [{ model_name: "model" }],
      created_at: "2026-03-04T00:00:00Z",
    });
  });

  it("filters out empty model names on submit", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const modelInput = screen.getByPlaceholderText("Model name");
    fireEvent.input(modelInput, { target: { value: "model-a" } });

    const addBtn = screen.getByText("+ Add model");
    await waitFor(() => expect(addBtn.hasAttribute("disabled")).toBe(false));
    fireEvent.click(addBtn);

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Test" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.example.com/v1" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Test",
        alias: "test",
        base_url: "https://api.example.com/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [{ model_name: "model-a" }],
      });
    });
  });

  it("adds and removes model rows", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const modelInput = screen.getByPlaceholderText("Model name");
    fireEvent.input(modelInput, { target: { value: "model-a" } });

    const addBtn = screen.getByText("+ Add model");
    await waitFor(() => expect(addBtn.hasAttribute("disabled")).toBe(false));
    fireEvent.click(addBtn);

    await waitFor(() => {
      const inputs = screen.getAllByPlaceholderText("Model name");
      expect(inputs).toHaveLength(2);
    });

    // Remove the second one
    const removeBtns = screen.getAllByTitle("Remove");
    fireEvent.click(removeBtns[1]);

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Model name")).toHaveLength(1);
    });
  });
});

describe("CustomProviderForm — Fetch models probe", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIsSelfHosted.mockResolvedValue(true);
  });

  it("fetches models via probe and populates the model rows", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "llama-3.1-8b" }, { model_name: "qwen2.5-7b" }],
    });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://host.docker.internal:8000/v1" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        "http://host.docker.internal:8000/v1",
        undefined,
        "openai",
        undefined,
        undefined,
      );
      const inputs = screen.getAllByPlaceholderText("Model name") as HTMLInputElement[];
      expect(inputs).toHaveLength(2);
      expect(inputs[0].value).toBe("llama-3.1-8b");
      expect(inputs[1].value).toBe("qwen2.5-7b");
    });
  });

  it("shows an inline error when the probe fails", async () => {
    mockProbeCustomProvider.mockRejectedValue(new Error("Connection refused"));

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://host.docker.internal:9999/v1" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(screen.getByText("Connection refused")).toBeDefined();
    });
  });

  it("populates probed models with models.dev prices", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [
        {
          model_name: "openai/gpt-4o-mini",
          input_price_per_million_tokens: 0.15,
          output_price_per_million_tokens: 0.6,
        },
      ],
    });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Kilo Gateway" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.kilo.ai/api/gateway" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        "https://api.kilo.ai/api/gateway",
        undefined,
        "openai",
        "Kilo Gateway",
        undefined,
      );
      expect(
        (screen.getByLabelText("Model 1 input price per million tokens") as HTMLInputElement).value,
      ).toBe("0.15");
      expect(
        (screen.getByLabelText("Model 1 output price per million tokens") as HTMLInputElement)
          .value,
      ).toBe("0.6");
    });
  });

  it("keeps price fields blank when the probe returns models without pricing", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "unknown-model" }],
    });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://host.docker.internal:8000/v1" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Model 1 input price per million tokens") as HTMLInputElement).value,
      ).toBe("");
      expect(
        (screen.getByLabelText("Model 1 output price per million tokens") as HTMLInputElement)
          .value,
      ).toBe("");
    });
  });

  it("shows estimated price info for model-only price fallbacks", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [
        {
          model_name: "openai/gpt-4o-mini",
          input_price_per_million_tokens: 0.15,
          output_price_per_million_tokens: 0.6,
          price_estimated: true,
        },
      ],
    });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Mammouth AI" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.mammouth.ai/v1" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Info: Estimated price. This may not be accurate."),
      ).toBeDefined();
    });
    expect(screen.getByText("Input / 1M tokens")).toBeDefined();
    expect(screen.getByText("Output / 1M tokens")).toBeDefined();
    expect(
      screen.getAllByLabelText("Info: Estimated price. This may not be accurate."),
    ).toHaveLength(1);

    fireEvent.mouseEnter(screen.getByLabelText("Info: Estimated price. This may not be accurate."));

    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe(
        "Estimated price. This may not be accurate.",
      );
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Mammouth AI",
        alias: "mammouth-ai",
        base_url: "https://api.mammouth.ai/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [
          {
            model_name: "openai/gpt-4o-mini",
            input_price_per_million_tokens: 0.15,
            output_price_per_million_tokens: 0.6,
            price_estimated: true,
          },
        ],
      });
    });
  });

  it("surfaces a 'no models' error when the server returns an empty list", async () => {
    mockProbeCustomProvider.mockResolvedValue({ models: [] });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://host.docker.internal:8000/v1" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(screen.getByText("Server returned no models")).toBeDefined();
    });
  });

  it("disables the Fetch models button when the base URL is empty", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const fetchBtn = screen.getByText("Fetch models");
    expect(fetchBtn.hasAttribute("disabled")).toBe(true);
  });
});

describe("CustomProviderForm — prefill from URL params", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCustomProvider.mockResolvedValue({
      id: "cp-1",
      name: "Groq",
      base_url: "https://api.groq.com/v1",
      api_kind: "openai",
      has_api_key: true,
      models: [{ model_name: "llama-3.1-70b" }],
      created_at: "2026-03-04T00:00:00Z",
    });
  });

  it("pre-fills fields from prefill prop", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        prefill={{
          name: "Groq",
          baseUrl: "https://api.groq.com/v1",
          apiKey: "gsk-test",
          models: [
            { model_name: "llama-3.1-70b", input_price: "0.59", output_price: "0.79" },
          ],
        }}
      />
    ));

    expect(
      (screen.getByPlaceholderText("e.g. Groq, Together, Azure") as HTMLInputElement).value,
    ).toBe("Groq");
    expect(
      (screen.getByPlaceholderText("https://api.example.com/v1") as HTMLInputElement).value,
    ).toBe("https://api.groq.com/v1");
    expect((screen.getByPlaceholderText("sk-...") as HTMLInputElement).value).toBe("gsk-test");
    expect((screen.getByLabelText("Model 1 name") as HTMLInputElement).value).toBe(
      "llama-3.1-70b",
    );
    expect(
      (screen.getByLabelText("Model 1 input price per million tokens") as HTMLInputElement).value,
    ).toBe("0.59");
    expect(
      (screen.getByLabelText("Model 1 output price per million tokens") as HTMLInputElement).value,
    ).toBe("0.79");
  });

  it("shows empty row when prefill has no models", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        prefill={{ name: "Test" }}
      />
    ));

    expect(
      (screen.getByPlaceholderText("e.g. Groq, Together, Azure") as HTMLInputElement).value,
    ).toBe("Test");
    expect((screen.getByPlaceholderText("Model name") as HTMLInputElement).value).toBe("");
  });

  it("submits prefilled data correctly", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        prefill={{
          name: "Groq",
          baseUrl: "https://api.groq.com/v1",
          models: [{ model_name: "llama-3.1-70b" }],
        }}
      />
    ));

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/v1",
        api_kind: "openai",
        apiKey: undefined,
        models: [{ model_name: "llama-3.1-70b" }],
      });
    });
  });
});

describe("CustomProviderForm — edit mode", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();
  const onDeleted = vi.fn();

  const initialData = {
    id: "cp-1",
    name: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    api_kind: "openai" as const,
    has_api_key: true,
    models: [
      {
        model_name: "llama-3.1-70b",
        input_price_per_million_tokens: 0.59,
        output_price_per_million_tokens: 0.79,
      },
    ],
    created_at: "2026-03-04T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCustomProvider.mockResolvedValue({ ...initialData, name: "Updated" });
    mockDeleteCustomProvider.mockResolvedValue({ ok: true });
  });

  it("renders with pre-populated fields", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    expect(screen.getByText("Edit custom provider")).toBeDefined();
    expect(screen.getByText("Save changes")).toBeDefined();
    expect((screen.getByPlaceholderText("e.g. Groq, Together, Azure") as HTMLInputElement).value).toBe("Groq");
    expect((screen.getByPlaceholderText("https://api.example.com/v1") as HTMLInputElement).value).toBe("https://api.groq.com/openai/v1");
  });

  it("renders with undefined models (toModelRows handles nullish)", () => {
    const noModels = { ...initialData, models: undefined as any };
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={noModels}
      />
    ));

    // The form renders without crashing; no model rows are pre-filled.
    expect(screen.getByText("Edit custom provider")).toBeDefined();
  });

  it("shows masked API key with Change button", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    expect(screen.getByDisplayValue("••••••••••••")).toBeDefined();
    expect(screen.getByText("Change")).toBeDefined();
  });

  it("shows 'No key set' when has_api_key is false", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={{ ...initialData, has_api_key: false }}
      />
    ));

    expect(screen.getByDisplayValue("No key set")).toBeDefined();
  });

  it("reveals API key input when Change is clicked", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Change"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk-...")).toBeDefined();
    });
  });

  it("calls updateCustomProvider on submit", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Updated Groq" },
    });

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-agent", "cp-1", {
        name: "Updated Groq",
        alias: null,
        base_url: "https://api.groq.com/openai/v1",
        models: [
          {
            model_name: "llama-3.1-70b",
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
        ],
      });
      expect(toast.success).toHaveBeenCalledWith("Updated Groq updated");
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it("includes apiKey in payload when key is changed", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Change"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk-...")).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText("sk-..."), {
      target: { value: "new-key-123" },
    });

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-agent", "cp-1", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/openai/v1",
        apiKey: "new-key-123",
        models: [
          {
            model_name: "llama-3.1-70b",
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
        ],
      });
    });
  });

  it("shows Delete provider button", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    expect(screen.getByText("Delete provider")).toBeDefined();
  });

  it("calls deleteCustomProvider and onDeleted on delete", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    // Click "Delete provider" to open confirmation modal
    fireEvent.click(screen.getByText("Delete provider"));

    // Click "Delete" in the confirmation modal
    await waitFor(() => {
      const deleteBtn = screen.getByText("Delete");
      expect(deleteBtn).toBeDefined();
    });
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockDeleteCustomProvider).toHaveBeenCalledWith("test-agent", "cp-1");
      expect(toast.success).toHaveBeenCalledWith("Groq removed");
      expect(onDeleted).toHaveBeenCalled();
    });
  });

  it("handles delete error gracefully", async () => {
    mockDeleteCustomProvider.mockRejectedValue(new Error("delete failed"));

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    // Click "Delete provider" to open confirmation modal
    fireEvent.click(screen.getByText("Delete provider"));

    // Click "Delete" in the confirmation modal
    await waitFor(() => {
      const deleteBtn = screen.getByText("Delete");
      expect(deleteBtn).toBeDefined();
    });
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockDeleteCustomProvider).toHaveBeenCalledWith("test-agent", "cp-1");
    });
    // Should not throw, should not call onDeleted
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("does not delete when confirm is cancelled", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    // Click "Delete provider" to open confirmation modal
    fireEvent.click(screen.getByText("Delete provider"));

    // Click "Cancel" in the confirmation modal
    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Cancel"));

    expect(mockDeleteCustomProvider).not.toHaveBeenCalled();
  });

  it("closes delete confirm modal on Escape key", async () => {
    const { container } = render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Delete provider"));
    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Escape" });

    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("shows Saving... text while submitting", async () => {
    let resolveSubmit: (v: unknown) => void;
    mockUpdateCustomProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      const btn = document.querySelector("button.btn--primary") as HTMLButtonElement;
      expect(btn.querySelector(".spinner")).not.toBeNull();
    });

    resolveSubmit!({ ...initialData });
  });

  it("shows error on update failure", async () => {
    mockUpdateCustomProvider.mockRejectedValue(new Error("Update failed"));

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Update failed")).toBeDefined();
    });
  });

  it("shows generic error message for non-Error exceptions on update", async () => {
    mockUpdateCustomProvider.mockRejectedValue("string error");

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Failed to update provider")).toBeDefined();
    });
  });

  it("pre-populates model rows from initialData", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    const modelInput = screen.getByLabelText("Model 1 name") as HTMLInputElement;
    expect(modelInput.value).toBe("llama-3.1-70b");
  });

  // ── Edit-mode "Fetch models" hint ──
  // Bug: in edit mode the form never has the plaintext API key (list() only
  // exposes has_api_key:bool), so the old probe call sent no key and any
  // server requiring auth returned 401. The fix is to forward the provider
  // id so the backend can decrypt the stored key and probe with it. These
  // three tests pin down the three branches: no editingKey → id hint only,
  // editingKey with typed key → new key wins, editingKey but field empty →
  // still send id (the typed-then-cleared edge).
  it("passes id (not apiKey) to probe when editing without clicking Change", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "llama-3.1-8b" }],
    });

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        initialData.base_url,
        undefined, // no plaintext key available — backend falls back to stored
        "openai",
        initialData.name, // provider_name still forwarded for enrichment
        initialData.id, // edit-mode hint
      );
    });
  });

  it("uses the typed apiKey (not id) when the user clicked Change and entered a new key", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "llama-3.1-8b" }],
    });

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Change"));
    fireEvent.input(screen.getByPlaceholderText("sk-..."), {
      target: { value: "sk-new-typed" },
    });
    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        initialData.base_url,
        "sk-new-typed", // user-typed key takes precedence
        "openai",
        initialData.name,
        undefined, // no id hint — we have an explicit key
      );
    });
  });

  it("still sends id when editingKey is open but the user left the field empty", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "llama-3.1-8b" }],
    });

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Change"));
    // Field opens but stays empty — user changed their mind. The probe
    // should still hit /models with the stored key, not unauthenticated.
    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        initialData.base_url,
        undefined,
        "openai",
        initialData.name,
        initialData.id,
      );
    });
  });
});

describe("CustomProviderForm — probe edge cases and model-row interactions", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIsSelfHosted.mockResolvedValue(true);
  });

  it("shows an error when Fetch models runs with an empty base URL", async () => {
    // Cover the defensive `if (!url)` early-exit inside handleProbe. We
    // type a URL so the Fetch button enables, clear the input, then
    // remove the disabled attribute from the DOM so jsdom dispatches the
    // click — the guard then reads '' from baseUrl() and short-circuits.
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://x" },
    });
    const btn = screen.getByText("Fetch models") as HTMLButtonElement;
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "" },
    });

    // Force-remove the disabled attribute so jsdom delivers the click to
    // our handler. (Solid will re-apply it on the next render tick.)
    btn.removeAttribute("disabled");
    btn.disabled = false;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText("Enter a base URL first")).toBeDefined();
    });
    expect(mockProbeCustomProvider).not.toHaveBeenCalled();
  });

  it("shows a non-Error probe rejection as 'Probe failed'", async () => {
    // Rejecting with a non-Error value exercises the string-error ternary
    // branch in handleProbe's catch block.
    mockProbeCustomProvider.mockRejectedValue("boom");

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "http://host.docker.internal:8000/v1" },
    });
    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(screen.getByText("Probe failed")).toBeDefined();
    });
  });

  it("leaves the rows untouched if removeRow is invoked while only one row exists", async () => {
    // Solid sets `disabled` on the remove button when only one row exists,
    // so jsdom won't deliver the click to the handler. We temporarily
    // strip `disabled` and fire the click to exercise the defensive
    // `prev.length <= 1 ? prev : prev.filter(...)` short-circuit.
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const removeBtn = screen.getByLabelText("Remove model 1") as HTMLButtonElement;
    removeBtn.removeAttribute("disabled");
    removeBtn.disabled = false;
    fireEvent.click(removeBtn);

    expect(screen.getAllByPlaceholderText("Model name")).toHaveLength(1);
  });

  it("updates only the targeted row when multiple rows exist", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    // Row 1
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "first" },
    });

    fireEvent.click(screen.getByText("+ Add model"));

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Model name")).toHaveLength(2);
    });

    // Edit row 2 to exercise updateRow when i !== index for the other row.
    const inputs = screen.getAllByPlaceholderText("Model name") as HTMLInputElement[];
    fireEvent.input(inputs[1], { target: { value: "second" } });

    await waitFor(() => {
      const refreshed = screen.getAllByPlaceholderText("Model name") as HTMLInputElement[];
      expect(refreshed[0].value).toBe("first");
      expect(refreshed[1].value).toBe("second");
    });
  });
});

describe("CustomProviderForm — API format selector", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCustomProvider.mockResolvedValue({
      id: "cp-1",
      name: "Azure Claude",
      base_url: "https://api.anthropic.com",
      api_kind: "anthropic",
      has_api_key: true,
      models: [{ model_name: "claude-sonnet-4-5" }],
      created_at: "2026-03-04T00:00:00Z",
    });
  });

  it("defaults to the OpenAI option and shows both paths", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    const openaiRadio = screen.getByRole("radio", { name: /OpenAI/ }) as HTMLInputElement;
    const anthropicRadio = screen.getByRole("radio", { name: /Anthropic/ }) as HTMLInputElement;
    expect(openaiRadio.checked).toBe(true);
    expect(anthropicRadio.checked).toBe(false);
    expect(screen.getByText("/v1/chat/completions")).toBeDefined();
    expect(screen.getByText("/v1/messages")).toBeDefined();
    expect(screen.getByText("Most providers use OpenAI format.")).toBeDefined();
  });

  it("swaps the base URL placeholder when Anthropic is selected", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    expect(screen.getByPlaceholderText("https://api.example.com/v1")).toBeDefined();

    const anthropicRadio = screen.getByRole("radio", { name: /Anthropic/ });
    fireEvent.click(anthropicRadio);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("https://api.anthropic.com")).toBeDefined();
      expect(screen.queryByPlaceholderText("https://api.example.com/v1")).toBeNull();
    });
  });

  it("submits api_kind='anthropic' after selecting the Anthropic option", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.click(screen.getByRole("radio", { name: /Anthropic/ }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("https://api.anthropic.com")).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText("e.g. Groq, Together, Azure"), {
      target: { value: "Azure Claude" },
    });
    fireEvent.input(screen.getByPlaceholderText("https://api.anthropic.com"), {
      target: { value: "https://api.anthropic.com" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "claude-sonnet-4-5" },
    });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith("test-agent", {
        name: "Azure Claude",
        alias: "azure-claude",
        base_url: "https://api.anthropic.com",
        api_kind: "anthropic",
        apiKey: undefined,
        models: [{ model_name: "claude-sonnet-4-5" }],
      });
    });
  });

  it("passes the selected api_kind to the probe call", async () => {
    mockProbeCustomProvider.mockResolvedValue({
      models: [{ model_name: "claude-sonnet-4-5" }],
    });

    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));

    fireEvent.click(screen.getByRole("radio", { name: /Anthropic/ }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("https://api.anthropic.com")).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText("https://api.anthropic.com"), {
      target: { value: "https://api.anthropic.com" },
    });

    fireEvent.click(screen.getByText("Fetch models"));

    await waitFor(() => {
      expect(mockProbeCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        "https://api.anthropic.com",
        undefined,
        "anthropic",
        undefined,
        undefined,
      );
    });
  });

  it("locks the format control and shows a muted note in edit mode", () => {
    const initialData = {
      id: "cp-1",
      name: "Azure Claude",
      base_url: "https://api.anthropic.com",
      api_kind: "anthropic" as const,
      has_api_key: true,
      models: [{ model_name: "claude-sonnet-4-5" }],
      created_at: "2026-03-04T00:00:00Z",
    };

    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    const anthropicRadio = screen.getByRole("radio", { name: /Anthropic/ }) as HTMLInputElement;
    const openaiRadio = screen.getByRole("radio", { name: /OpenAI/ }) as HTMLInputElement;
    expect(anthropicRadio.checked).toBe(true);
    expect(anthropicRadio.disabled).toBe(true);
    expect(openaiRadio.disabled).toBe(true);
    expect(
      screen.getByText(/Format can't be changed after creation/),
    ).toBeDefined();
  });
});

describe("CustomProviderForm — edit mode: extra API key + delete UI branches", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();
  const onDeleted = vi.fn();
  const initialData = {
    id: "cp-1",
    name: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    api_kind: "openai" as const,
    has_api_key: true,
    models: [
      {
        model_name: "llama-3.1-70b",
        input_price_per_million_tokens: 0.59,
        output_price_per_million_tokens: 0.79,
      },
    ],
    created_at: "2026-03-04T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCustomProvider.mockResolvedValue({ ...initialData, name: "Updated" });
    mockDeleteCustomProvider.mockResolvedValue({ ok: true });
  });

  it("sends apiKey=undefined when Change is clicked and the new key is left blank", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Change"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk-...")).toBeDefined();
    });

    // Leave the input empty to exercise the `|| undefined` fallback when
    // the trimmed string is empty.
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-agent", "cp-1", {
        name: "Groq",
        alias: null,
        base_url: "https://api.groq.com/openai/v1",
        apiKey: undefined,
        models: [
          {
            model_name: "llama-3.1-70b",
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
        ],
      });
    });
  });

  it("closes the confirm modal when the overlay itself is clicked", async () => {
    const { container } = render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Delete provider"));
    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    // Click directly on the overlay — since e.target === e.currentTarget
    // the handler closes the dialog.
    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.click(overlay);

    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("clicks inside the confirm modal content without closing the modal", async () => {
    const { container } = render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Delete provider"));
    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    // Click on the modal card itself — because e.target !== e.currentTarget
    // the overlay handler should NOT close the dialog.
    const card = container.querySelector(".modal-card") as HTMLElement;
    fireEvent.click(card);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("closes the confirm modal when the close (X) button is clicked", async () => {
    const { container } = render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        onDeleted={onDeleted}
        initialData={initialData}
      />
    ));

    fireEvent.click(screen.getByText("Delete provider"));
    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});

describe("CustomProviderForm — alias", () => {
  const onCreated = vi.fn();
  const onBack = vi.fn();

  const aliasInput = () => screen.getByPlaceholderText("e.g. vercel-ai-gateway") as HTMLInputElement;
  const nameInput = () => screen.getByPlaceholderText("e.g. Groq, Together, Azure");

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCustomProvider.mockResolvedValue({});
    mockUpdateCustomProvider.mockResolvedValue({});
  });

  it("derives the alias from the name while creating and previews the model id", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    expect(aliasInput().value).toBe("");
    expect(screen.getByTestId("cp-alias-hint").textContent).toContain("custom:<provider-id>/<model>");

    fireEvent.input(nameInput(), { target: { value: "Vercel AI Gateway" } });
    expect(aliasInput().value).toBe("vercel-ai-gateway");
    expect(screen.getByTestId("cp-alias-hint").textContent).toContain("vercel-ai-gateway/<model>");
  });

  it("stops following the name once the alias was edited by hand", () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    fireEvent.input(aliasInput(), { target: { value: "gw" } });
    fireEvent.input(nameInput(), { target: { value: "Vercel AI Gateway" } });
    expect(aliasInput().value).toBe("gw");
  });

  it("derives the alias from a prefilled name", () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        prefill={{ name: "Mammouth AI", baseUrl: "https://api.mammouth.ai/v1", models: [] }}
      />
    ));
    expect(aliasInput().value).toBe("mammouth-ai");
  });

  it("sends a null alias when the field is cleared", async () => {
    render(() => (
      <CustomProviderForm agentName="test-agent" onCreated={onCreated} onBack={onBack} />
    ));
    fireEvent.input(nameInput(), { target: { value: "Groq" } });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.groq.com/v1" },
    });
    fireEvent.input(screen.getByPlaceholderText("Model name"), {
      target: { value: "llama-3.1-70b" },
    });
    fireEvent.input(aliasInput(), { target: { value: "   " } });

    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        expect.objectContaining({ alias: null }),
      );
    });
  });

  it("shows the stored alias in edit mode, leaves it alone on rename, and sends it normalised", async () => {
    render(() => (
      <CustomProviderForm
        agentName="test-agent"
        onCreated={onCreated}
        onBack={onBack}
        initialData={{
          id: "cp-1",
          name: "Groq",
          alias: "groq",
          base_url: "https://api.groq.com/openai/v1",
          api_kind: "openai",
          has_api_key: true,
          models: [{ model_name: "llama-3.1-70b" }],
          created_at: "2026-03-04T00:00:00Z",
        }}
      />
    ));
    expect(aliasInput().value).toBe("groq");
    expect(screen.getByTestId("cp-alias-hint").textContent).toContain(
      "Changing the alias changes the model ids your clients use.",
    );

    fireEvent.input(nameInput(), { target: { value: "Groq Cloud" } });
    expect(aliasInput().value).toBe("groq");

    fireEvent.input(aliasInput(), { target: { value: " Groq-Cloud " } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith(
        "test-agent",
        "cp-1",
        expect.objectContaining({ name: "Groq Cloud", alias: "groq-cloud" }),
      );
    });
  });
});
