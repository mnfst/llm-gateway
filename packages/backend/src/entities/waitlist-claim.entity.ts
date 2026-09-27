import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('waitlist_claims')
export class WaitlistClaim {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { unique: true })
  email!: string;

  @Column('varchar', { default: 'self-hosted' })
  source!: string;

  @Column('timestamp with time zone', { default: () => 'now()' })
  claimed_at!: string;
}
