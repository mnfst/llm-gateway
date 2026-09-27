import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => {
    const { href, class: className, children, ...rest } = props;
    return <a href={href as string} class={className as string} {...rest}>{children}</a>;
  },
}));

vi.mock("@solidjs/meta", () => ({
  Title: (props: Record<string, unknown>) => <title>{props.children}</title>,
  Meta: () => null,
}));

import Help from "../../src/pages/Help";

describe("Help", () => {
  it("shows Help & Support heading", () => {
    render(() => <Help />);
    expect(screen.getByText("Help & Support")).toBeDefined();
  });

  it("shows Schedule a Call section", () => {
    render(() => <Help />);
    expect(screen.getByText("Schedule a Call")).toBeDefined();
  });

  it("shows Email Support section", () => {
    render(() => <Help />);
    expect(screen.getByText("Email Support")).toBeDefined();
  });

  it("has Book link", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    const bookLink = links.find((l) => l.textContent?.includes("Book"));
    expect(bookLink).toBeDefined();
  });

  it("has Contact link", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    const contactLink = links.find((l) => l.textContent?.includes("Contact"));
    expect(contactLink).toBeDefined();
  });

  it("Calendly link has correct href", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    const bookLink = links.find((l) => l.textContent?.includes("Book"));
    expect(bookLink?.getAttribute("href")).toBe(
      "https://calendly.com/sebastien-manifest/15min",
    );
  });

  it("Calendly link opens in new tab with noopener noreferrer", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    const bookLink = links.find((l) => l.textContent?.includes("Book"));
    expect(bookLink?.getAttribute("target")).toBe("_blank");
    expect(bookLink?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("Email link is mailto", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    const contactLink = links.find((l) => l.textContent?.includes("Contact"));
    expect(contactLink?.getAttribute("href")).toBe(
      "mailto:sebastien@manifest.build",
    );
  });

  it("renders Title metadata", () => {
    const { container } = render(() => <Help />);
    const title = container.querySelector("title");
    expect(title?.textContent).toContain("Help & Support - Manifest");
  });

  it("renders breadcrumb prompt text", () => {
    render(() => <Help />);
    expect(
      screen.getByText(
        /Questions or issues\? Reach out and we'll get back to you quickly/,
      ),
    ).toBeDefined();
  });

  it("describes the call duration in the Schedule a Call section", () => {
    render(() => <Help />);
    expect(
      screen.getByText(/Book a 15-min call with us to get help setting things up\./),
    ).toBeDefined();
  });

  it("shows the support email address with the response window", () => {
    render(() => <Help />);
    expect(
      screen.getByText(/sebastien@manifest.build/),
    ).toBeDefined();
    expect(
      screen.getByText(/we typically respond within 24 hours/),
    ).toBeDefined();
  });

  it("renders exactly two action links (Book and Contact)", () => {
    render(() => <Help />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(2);
  });
});
