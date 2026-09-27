import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnableRecordingForNewAgents1801500000000 implements MigrationInterface {
  name = 'EnableRecordingForNewAgents1801500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "record_messages" SET DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ALTER COLUMN "record_messages" SET DEFAULT false`,
    );
  }
}
