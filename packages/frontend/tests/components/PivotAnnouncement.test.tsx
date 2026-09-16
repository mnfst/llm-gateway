import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

const mockStopBlobCanvas = vi.fn();
const mockInitBlobCanvas = vi.fn(() => mockStopBlobCanvas);

vi.mock('../../src/services/blob-canvas.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/blob-canvas.js')>();
  return {
    ...actual,
    initBlobCanvas: (...args: unknown[]) => mockInitBlobCanvas(...(args as [HTMLCanvasElement])),
  };
});

import PivotAnnouncement, { MANIFEST_SIGNUP_URL } from '../../src/components/PivotAnnouncement';

const CARD_TITLE = 'Manifest, the self-healing layer for APIs';

describe('PivotAnnouncement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders the card with a Try Manifest link to the dashboard signup', () => {
    const { container } = render(() => <PivotAnnouncement />);
    expect(screen.getByText(CARD_TITLE)).toBeDefined();
    const link = screen.getByText('Try Manifest').closest('a')!;
    expect(MANIFEST_SIGNUP_URL).toBe('https://dashboard.manifest.build/signup');
    expect(link.getAttribute('href')).toBe(MANIFEST_SIGNUP_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('.modal-card')).toBeNull();
  });

  it('splits into a canvas-backed top band and a plain bottom band, without the star icon', () => {
    const { container } = render(() => <PivotAnnouncement />);
    const top = container.querySelector('.sidebar-pivot__top');
    expect(top).not.toBeNull();
    expect(top!.querySelector('canvas.sidebar-pivot__canvas')).not.toBeNull();
    expect(mockInitBlobCanvas).toHaveBeenCalledTimes(1);
    // The header holds only the title and the dismiss button: no leading icon.
    expect(container.querySelectorAll('.sidebar-pivot__header > svg')).toHaveLength(0);
    const bottom = container.querySelector('.sidebar-pivot__bottom');
    expect(bottom!.querySelector('.sidebar-pivot__desc')).not.toBeNull();
    expect(bottom!.querySelector('a.sidebar-pivot__btn')).not.toBeNull();
  });

  it('stops the canvas animation when the card is dismissed', () => {
    const { container } = render(() => <PivotAnnouncement />);
    expect(mockStopBlobCanvas).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.sidebar-pivot__dismiss')!);
    expect(mockStopBlobCanvas).toHaveBeenCalledTimes(1);
  });

  it('dismisses for the session and comes back in a fresh session', () => {
    const { container, unmount } = render(() => <PivotAnnouncement />);
    fireEvent.click(container.querySelector('.sidebar-pivot__dismiss')!);
    expect(container.querySelector('.sidebar-pivot')).toBeNull();
    expect(sessionStorage.getItem('manifest-card-dismissed')).toBe('1');
    unmount();

    const second = render(() => <PivotAnnouncement />);
    expect(second.container.querySelector('.sidebar-pivot')).toBeNull();
    second.unmount();

    sessionStorage.clear();
    const third = render(() => <PivotAnnouncement />);
    expect(third.container.querySelector('.sidebar-pivot')).not.toBeNull();
  });

  it('shows again for people who hid the old waiting-list card', () => {
    sessionStorage.setItem('pivot-card-dismissed', '1');
    const { container } = render(() => <PivotAnnouncement />);
    expect(container.querySelector('.sidebar-pivot')).not.toBeNull();
  });
});
