import { createSignal, For, Show, type JSX } from 'solid-js';
import type { MessageRow, MessageColumnKey } from './message-table-types.js';
import MessageDetails from './MessageDetails.jsx';
import { columnHeader, renderCell } from './message-table-cells.jsx';

export interface MessageTableProps {
  items: MessageRow[];
  columns: MessageColumnKey[];
  agentName?: string;
  customProviderName: (model: string) => string | undefined;
  agentPlatformLookup?: (
    name: string,
  ) => { platform: string | null; category: string | null } | undefined;
  onFallbackErrorClick?: (model: string) => void;
  onTriggerClick?: (id: string) => void;
  /** Open a linked message (Autofix sibling) from an expanded row's detail. */
  onOpenMessage?: (id: string) => void;
  rowIdPrefix?: string;
  showHeaderTooltips?: boolean;
  expandable?: boolean;
  /** When set, clicking a row calls this instead of expanding inline (drawer mode). */
  onRowSelect?: (id: string) => void;
  /** The currently selected row ID (for focus highlight in drawer mode). */
  selectedRowId?: string | null;
}

function ChevronIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ExpandableRow(props: {
  item: MessageRow;
  columns: MessageColumnKey[];
  tableProps: MessageTableProps;
  rowId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const colSpan = () => props.columns.length + 1;
  const ctx = {
    agentName: props.tableProps.agentName,
    customProviderName: props.tableProps.customProviderName,
    agentPlatformLookup: props.tableProps.agentPlatformLookup,
    onFallbackErrorClick: props.tableProps.onFallbackErrorClick,
    onTriggerClick: props.tableProps.onTriggerClick,
  };

  const useDrawer = () => !!props.tableProps.onRowSelect;

  const handleRowClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, [role="button"]')) return;
    if (useDrawer()) {
      props.tableProps.onRowSelect!(props.item.id);
    } else {
      setExpanded(!expanded());
    }
  };

  return (
    <>
      <tr
        id={props.rowId}
        class={`msg-row--clickable${expanded() ? ' msg-row--expanded' : ''}${useDrawer() && props.tableProps.selectedRowId === props.item.id ? ' msg-row--selected' : ''}`}
        onClick={handleRowClick}
      >
        <For each={props.columns}>{(col) => renderCell(col, props.item, ctx)}</For>
        <Show when={!useDrawer()}>
          <td class="msg-detail__chevron-cell">
            <button
              class={`msg-detail__chevron-btn${expanded() ? ' msg-detail__chevron-btn--open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded());
              }}
              aria-expanded={expanded()}
              aria-label={expanded() ? 'Collapse details' : 'Expand details'}
              title={expanded() ? 'Collapse details' : 'Expand details'}
            >
              <ChevronIcon />
            </button>
          </td>
        </Show>
      </tr>
      <Show when={expanded() && !useDrawer()}>
        <tr class="msg-detail__row">
          <td colspan={colSpan()} class="msg-detail__cell">
            <MessageDetails
              messageId={props.item.id}
              onOpenMessage={props.tableProps.onOpenMessage}
            />
          </td>
        </tr>
      </Show>
    </>
  );
}

function PlainRow(props: {
  item: MessageRow;
  columns: MessageColumnKey[];
  tableProps: MessageTableProps;
  rowId?: string;
}): JSX.Element {
  const ctx = {
    agentName: props.tableProps.agentName,
    customProviderName: props.tableProps.customProviderName,
    agentPlatformLookup: props.tableProps.agentPlatformLookup,
    onFallbackErrorClick: props.tableProps.onFallbackErrorClick,
    onTriggerClick: props.tableProps.onTriggerClick,
  };
  return (
    <tr id={props.rowId}>
      <For each={props.columns}>{(col) => renderCell(col, props.item, ctx)}</For>
    </tr>
  );
}

export default function MessageTable(props: MessageTableProps): JSX.Element {
  return (
    <table class="data-table">
      <thead>
        <tr>
          <For each={props.columns}>
            {(col) => <th data-col={col}>{columnHeader(col, props.showHeaderTooltips)}</th>}
          </For>
          <Show when={props.expandable}>
            <th class="msg-detail__chevron-th" />
          </Show>
        </tr>
      </thead>
      <tbody>
        <For each={props.items}>
          {(item) =>
            props.expandable ? (
              <ExpandableRow
                item={item}
                columns={props.columns}
                tableProps={props}
                rowId={props.rowIdPrefix ? `${props.rowIdPrefix}${item.id}` : undefined}
              />
            ) : (
              <PlainRow
                item={item}
                columns={props.columns}
                tableProps={props}
                rowId={props.rowIdPrefix ? `${props.rowIdPrefix}${item.id}` : undefined}
              />
            )
          }
        </For>
      </tbody>
    </table>
  );
}
