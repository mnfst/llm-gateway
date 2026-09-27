import { Column, Entity, PrimaryColumn } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

@Entity('agent_usage_daily')
export class AgentUsageDaily {
  @PrimaryColumn('varchar')
  tenant_id!: string;

  @PrimaryColumn('varchar')
  agent_id!: string;

  @PrimaryColumn('date')
  day!: string;

  @Column('bigint', { default: 0 })
  request_count!: string;

  @Column('bigint', { default: 0 })
  successful_request_count!: string;

  @Column('bigint', { default: 0 })
  failed_request_count!: string;

  @Column('bigint', { default: 0 })
  input_tokens!: string;

  @Column('bigint', { default: 0 })
  output_tokens!: string;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  cost_usd!: string;

  @Column(timestampType(), { nullable: true })
  last_active_at!: string | null;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}
