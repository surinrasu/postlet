import { MailAccount } from "../../dist/worker.js";

export { AuthState, default } from "../../dist/worker.js";

export class MaintenanceAccount extends MailAccount {
  beginOperation() {
    this.heldOperation = this.withMailOperation(
      () =>
        new Promise((resolve) => {
          this.releaseOperation = resolve;
        }),
    );
    this.ctx.waitUntil(this.heldOperation);
  }
  async endOperation() {
    this.releaseOperation();
    await this.heldOperation;
  }

  async collectAndReupload(bytes, type) {
    // Pause R2 deletion after candidates have been selected. A concurrent upload
    // of the same content must wait until collection finishes, then restore it.
    const remove = this.env.MAIL.delete.bind(this.env.MAIL);
    let enter, resume;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    this.env.MAIL.delete = async (key) => {
      enter();
      await paused;
      return remove(key);
    };
    try {
      const collecting = this.collectStorage(true);
      await entered;
      const uploading = this.upload(bytes, type);
      const activeDuringCollection = this.activeOperations;
      resume();
      const result = await collecting;
      const upload = await uploading;
      return {
        activeDuringCollection,
        deleted: result.deleted,
        blobId: upload.blobId,
      };
    } finally {
      this.env.MAIL.delete = remove;
    }
  }
}
