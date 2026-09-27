import { For } from 'solid-js';

const OverviewSkeleton = () => (
  <>
    <div class="chart-card">
      <div class="chart-card__header">
        <div class="chart-card__stat chart-card__stat--active">
          <span class="chart-card__label">Requests</span>
          <div class="chart-card__value-row">
            <div class="skeleton skeleton--text" style="width: 50px; height: 28px;" />
          </div>
        </div>
        <div class="chart-card__stat">
          <span class="chart-card__label">Cost</span>
          <div class="chart-card__value-row">
            <div class="skeleton skeleton--text" style="width: 80px; height: 28px;" />
          </div>
        </div>
        <div class="chart-card__stat">
          <span class="chart-card__label">Token usage</span>
          <div class="chart-card__value-row">
            <div class="skeleton skeleton--text" style="width: 70px; height: 28px;" />
          </div>
        </div>
      </div>
      <div class="chart-card__body">
        <div class="skeleton skeleton--rect" style="width: 100%; height: 260px;" />
      </div>
    </div>
    <div class="panel">
      <div
        class="panel__title"
        style="display: flex; justify-content: space-between; align-items: center;"
      >
        Recent Requests
        <span class="view-more-link" style="pointer-events: none; opacity: 0.4;">
          View more
        </span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Request</th>
            <th>Cost</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <For each={[1, 2, 3, 4, 5]}>
            {() => (
              <tr>
                <td>
                  <div class="skeleton skeleton--text" style="width: 70%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 50%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 50%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 70%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 40%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 50%;" />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
    <div class="panel" style="margin-top: var(--gap-lg);">
      <div class="panel__title">Cost by Model</div>
      <p style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin: -8px 0 12px;">
        How much each AI model is costing you
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens</th>
            <th>% of total</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          <For each={[1, 2, 3]}>
            {() => (
              <tr>
                <td>
                  <div class="skeleton skeleton--text" style="width: 60%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 40%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 50%;" />
                </td>
                <td>
                  <div class="skeleton skeleton--text" style="width: 40%;" />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </>
);

export default OverviewSkeleton;
