import { Resend } from 'resend';

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export interface OtpMailer {
  send(input: { email: string; otp: string; purpose: OtpPurpose }): Promise<void>;
}

export function createResendOtpMailer(apiKey: string, from: string): OtpMailer {
  const resend = new Resend(apiKey);

  return {
    async send({ email, otp, purpose }) {
      const { error } = await resend.emails.send({
        from,
        to: email,
        subject: getSubject(purpose),
        text: getText(otp),
        html: getHtml(otp),
      });

      if (error) {
        throw new Error(`OTP_EMAIL_SEND_FAILED:${error.name}`);
      }
    },
  };
}

function getSubject(purpose: OtpPurpose) {
  if (purpose === 'change-email') return '[NUEAT] 이메일 변경 인증번호';
  return '[NUEAT] 로그인 인증번호';
}

function getText(otp: string) {
  return `NUEAT 인증번호는 ${otp}입니다. 이 번호는 5분 동안 유효합니다. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.`;
}

function getHtml(otp: string) {
  return `<!doctype html>
<html lang="ko">
  <body style="margin:0;background:#f5f7f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17211b">
    <main style="max-width:480px;margin:0 auto;padding:40px 20px">
      <section style="background:#ffffff;border-radius:20px;padding:32px">
        <p style="margin:0 0 20px;color:#16794a;font-size:14px;font-weight:800;letter-spacing:1px">NUEAT</p>
        <h1 style="margin:0 0 12px;font-size:24px">로그인 인증번호</h1>
        <p style="margin:0 0 24px;color:#5f6b64;line-height:1.6">아래 인증번호를 NUEAT 앱에 입력해 주세요.</p>
        <p style="margin:0 0 24px;padding:20px;border-radius:14px;background:#eef7f1;text-align:center;font-size:32px;font-weight:800;letter-spacing:8px">${otp}</p>
        <p style="margin:0;color:#5f6b64;font-size:13px;line-height:1.6">인증번호는 5분 동안 유효합니다. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.</p>
      </section>
    </main>
  </body>
</html>`;
}
