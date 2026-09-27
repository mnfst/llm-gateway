import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReclassifyPlanRequestLimitMessages1800100000000 implements MigrationInterface {
  name = 'ReclassifyPlanRequestLimitMessages1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE agent_messages
         SET routing_reason = 'plan_request_limit_exceeded',
             error_class = 'plan_request_limit_exceeded'
       WHERE error_origin = 'policy'
         AND error_class = 'limit_exceeded'
         AND routing_reason = 'limit_exceeded'
         AND error_http_status = 402
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE agent_messages
         SET routing_reason = 'limit_exceeded',
             error_class = 'limit_exceeded'
       WHERE error_origin = 'policy'
         AND error_class = 'plan_request_limit_exceeded'
         AND routing_reason = 'plan_request_limit_exceeded'
         AND error_http_status = 402
    `);
  }
}
