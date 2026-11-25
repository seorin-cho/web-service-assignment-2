import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  return {
        apply(actor, eventId) {
      repo.db.exec('BEGIN IMMEDIATE');
      try {
        if (!repo.event(eventId)) {
          throw missing('행사');
        }
        if (actor.role !== 'STUDENT') {
          throw forbidden();
        }
        if (repo.existing(eventId, actor.id)) {
          throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
        }

        const application = repo.insert(eventId, actor.id);
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: 'APPLY',
          fromStatus: null,
          toStatus: 'PENDING',
        });

        repo.db.exec('COMMIT');
        return application;
      } catch (error) {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
        cancel(actor, applicationId) {
      repo.db.exec('BEGIN IMMEDIATE');
      try {
        const application = repo.application(applicationId);
        if (!application) {
          throw missing('신청');
        }
        if (actor.role !== 'STUDENT' || application.userId !== actor.id) {
          throw forbidden();
        }
        if (application.status !== 'PENDING') {
          throw invalidState();
        }

        const cancelled = repo.setStatus(applicationId, 'CANCELLED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED',
        });

        repo.db.exec('COMMIT');
        return cancelled;
      } catch (error) {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
        approve(actor, applicationId) {
      repo.db.exec('BEGIN IMMEDIATE');
      try {
        const application = repo.application(applicationId);
        if (!application) {
          throw missing('신청');
        }

        const event = repo.event(application.eventId);
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) {
          throw forbidden();
        }
        if (application.status !== 'PENDING') {
          throw invalidState();
        }
        if (repo.approvedCount(event.id) >= event.capacity) {
          throw new AppError(409, 'CAPACITY_FULL', '행사 정원이 찼습니다.');
        }

        const approved = repo.setStatus(applicationId, 'APPROVED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED',
        });

        repo.db.exec('COMMIT');
        return approved;
      } catch (error) {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    },
        revoke(actor, applicationId, reason) {
      repo.db.exec('BEGIN IMMEDIATE');
      try {
        const application = repo.application(applicationId);
        if (!application) {
          throw missing('신청');
        }

        const event = repo.event(application.eventId);
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) {
          throw forbidden();
        }
        if (application.status !== 'APPROVED') {
          throw invalidState();
        }

        const revoked = repo.setStatus(applicationId, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason,
        });

        const next = repo.nextPending(event.id);
        let promoted = null;
        if (next) {
          promoted = repo.setStatus(next.id, 'APPROVED');
          repo.addHistory({
            applicationId: next.id,
            actorId: actor.id,
            action: 'AUTO_APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            causeHistoryId: revokeHistoryId,
          });
        }

        repo.db.exec('COMMIT');
        return { revoked, promoted };
      } catch (error) {
        repo.db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
