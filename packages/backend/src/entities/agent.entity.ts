import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn, OneToOne, Index } from 'typeorm';
import { Tenant } from './tenant.entity';
import { AgentApiKey } from './agent-api-key.entity';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

@Entity('agents')
@Index(['tenant_id', 'name'], { unique: true, where: '"deleted_at" IS NULL' })
export class Agent {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  name!: string;

  @Column('varchar', { nullable: true })
  display_name!: string | null;

  @Column('varchar', { nullable: true })
  description!: string | null;

  @Column('varchar', { nullable: true })
  agent_category!: string | null;

  @Column('varchar', { nullable: true })
  agent_platform!: string | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @Column('boolean', { default: false })
  complexity_routing_enabled!: boolean;

  // Autofix: when enabled, a request-side 4xx is sent to the healing service
  // (Phoenix) and the patched request is resent once before the fallback chain runs.
  // Nullable: NULL means "no explicit choice — inherit the deployment-mode default"
  // (ON in cloud, OFF in self-hosted), resolved in AutofixService.resolveEnabled().
  @Column('boolean', { nullable: true })
  autofix_enabled!: boolean | null;

  // Enabled for newly created agents. Existing agents keep their persisted
  // choice because the migration changes only the column default.
  @Column('boolean', { default: true })
  record_messages!: boolean;

  // Reserved Playground agent (the per-tenant "Playground" agent). Hidden
  // from the agent list / switcher / counts and not user-creatable/renamable.
  @Column('boolean', { default: false })
  is_playground!: boolean;

  @ManyToOne(() => Tenant, (t) => t.agents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column('varchar')
  tenant_id!: string;

  @OneToOne(() => AgentApiKey, (k) => k.agent, { cascade: true })
  apiKey!: AgentApiKey;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;

  @Column(timestampType(), { nullable: true, default: null })
  deleted_at!: string | null;
}
