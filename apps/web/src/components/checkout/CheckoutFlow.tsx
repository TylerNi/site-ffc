'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  isValidCanadianPostalCode,
  isValidUsZip,
  PROVINCE_CODES,
  PROVINCES,
  US_STATE_CODES,
} from '@ffc/core';
import { type Locale } from '@ffc/i18n';
import {
  ApiError,
  type Cart,
  type CheckoutAddressInput,
  type CheckoutSession,
  createCheckoutSession,
  fetchCart,
  type OrderSummary,
} from '@/lib/cart-client';
import { formatMoney } from '@/components/cart/CartView';

export interface CheckoutLabels {
  title: string;
  contact: string;
  email: string;
  emailHelp: string;
  shippingAddress: string;
  firstName: string;
  lastName: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  country: string;
  countryCA: string;
  countryUS: string;
  province: string;
  state: string;
  postalCode: string;
  zipCode: string;
  phone: string;
  invalidEmail: string;
  invalidPostalCode: string;
  invalidZip: string;
  requiredField: string;
  coupon: string;
  couponPlaceholder: string;
  note: string;
  continueToPayment: string;
  preparing: string;
  payment: string;
  editDetails: string;
  payButton: string;
  processing: string;
  paymentUnavailable: string;
  paymentNotConfigured: string;
  summary: string;
  subtotal: string;
  shipping: string;
  freeShipping: string;
  discount: string;
  taxGst: string;
  taxQst: string;
  taxHst: string;
  taxPst: string;
  total: string;
  secureNotice: string;
  cartChanged: string;
  cartEmpty: string;
  backToCart: string;
  genericError: string;
  couponErrors: Record<string, string>;
}

interface CheckoutFlowProps {
  locale: Locale;
  labels: CheckoutLabels;
  publishableKey: string | null;
  cartPath: string;
  successPath: string;
}

interface AddressFormState {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  country: 'CA' | 'US';
  province: string;
  postalCode: string;
  phone: string;
  couponCode: string;
  customerNote: string;
}

const EMPTY_FORM: AddressFormState = {
  email: '',
  firstName: '',
  lastName: '',
  company: '',
  line1: '',
  line2: '',
  city: '',
  country: 'CA',
  province: 'QC',
  postalCode: '',
  phone: '',
  couponCode: '',
  customerNote: '',
};

type FieldErrors = Partial<Record<keyof AddressFormState, string>>;

function validate(form: AddressFormState, labels: CheckoutLabels): FieldErrors {
  const errors: FieldErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = labels.invalidEmail;
  for (const field of ['firstName', 'lastName', 'line1', 'city'] as const) {
    if (form[field].trim().length === 0) errors[field] = labels.requiredField;
  }
  if (form.country === 'CA' && !isValidCanadianPostalCode(form.postalCode)) {
    errors.postalCode = labels.invalidPostalCode;
  }
  if (form.country === 'US' && !isValidUsZip(form.postalCode)) {
    errors.postalCode = labels.invalidZip;
  }
  return errors;
}

/** Ligne du panneau récapitulatif (masquée quand le montant est nul). */
function SummaryRow({
  label,
  cents,
  locale,
  strong,
}: {
  label: string;
  cents: number;
  locale: Locale;
  strong?: boolean;
}) {
  const amount = formatMoney(cents, 'CAD', locale);
  return (
    <div className={strong ? 'summary-row summary-total' : 'summary-row'}>
      <span>{label}</span>
      {strong ? <strong>{amount}</strong> : <span>{amount}</span>}
    </div>
  );
}

function OrderPanel({
  order,
  labels,
  locale,
}: {
  order: OrderSummary;
  labels: CheckoutLabels;
  locale: Locale;
}) {
  return (
    <aside className="card checkout-summary">
      <h2>{labels.summary}</h2>
      <ul className="summary-lines">
        {order.lines.map((line) => (
          <li key={line.sku}>
            <span>
              {line.quantity} × {locale === 'fr' ? line.nameFr : line.nameEn}
            </span>
            <span>{formatMoney(line.subtotalCents, order.currency, locale)}</span>
          </li>
        ))}
      </ul>
      <SummaryRow label={labels.subtotal} cents={order.subtotalCents} locale={locale} />
      {order.discountCents > 0 && (
        <div className="summary-row summary-discount">
          <span>
            {labels.discount}
            {order.couponCode ? ` (${order.couponCode})` : ''}
          </span>
          <span>−{formatMoney(order.discountCents, order.currency, locale)}</span>
        </div>
      )}
      <div className="summary-row">
        <span>{labels.shipping}</span>
        <span>
          {order.shippingCents === 0
            ? labels.freeShipping
            : formatMoney(order.shippingCents, order.currency, locale)}
        </span>
      </div>
      {order.taxGstCents > 0 && (
        <SummaryRow label={labels.taxGst} cents={order.taxGstCents} locale={locale} />
      )}
      {order.taxQstCents > 0 && (
        <SummaryRow label={labels.taxQst} cents={order.taxQstCents} locale={locale} />
      )}
      {order.taxHstCents > 0 && (
        <SummaryRow label={labels.taxHst} cents={order.taxHstCents} locale={locale} />
      )}
      {order.taxPstCents > 0 && (
        <SummaryRow label={labels.taxPst} cents={order.taxPstCents} locale={locale} />
      )}
      <SummaryRow label={labels.total} cents={order.totalCents} locale={locale} strong />
      <p className="muted small">{labels.secureNotice}</p>
    </aside>
  );
}

/** Formulaire de paiement (à l'intérieur du provider Elements). */
function PaymentForm({
  session,
  labels,
  locale,
  successPath,
  onEdit,
}: {
  session: CheckoutSession;
  labels: CheckoutLabels;
  locale: Locale;
  successPath: string;
  onEdit: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const successUrl = () => {
    const url = new URL(successPath, window.location.origin);
    return url.toString();
  };

  const pay = async () => {
    if (!stripe || !elements) return;
    setPaying(true);
    setError(null);
    // 3DS et portefeuilles gérés par Stripe : redirection seulement si la
    // méthode l'exige, sinon retour direct ici puis navigation manuelle.
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: successUrl() },
      redirect: 'if_required',
    });
    if (result.error) {
      setError(result.error.message ?? labels.genericError);
      setPaying(false);
      return;
    }
    const intent = result.paymentIntent;
    const params = new URLSearchParams({
      payment_intent: intent.id,
      payment_intent_client_secret: intent.client_secret ?? session.clientSecret,
    });
    window.location.assign(`${successPath}?${params.toString()}`);
  };

  return (
    <div className="checkout-payment">
      <h2>{labels.payment}</h2>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && (
        <p className="cart-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn cart-checkout-btn"
        disabled={!stripe || paying}
        onClick={() => void pay()}
      >
        {paying
          ? labels.processing
          : labels.payButton.replace(
              '{amount}',
              formatMoney(session.order.totalCents, session.order.currency, locale),
            )}
      </button>
      <button type="button" className="btn-ghost" onClick={onEdit} disabled={paying}>
        {labels.editDetails}
      </button>
    </div>
  );
}

/**
 * Parcours de checkout (une page, deux étapes) :
 *   1. coordonnées + adresse validées localement (mêmes règles @ffc/core
 *      que le serveur), puis POST /checkout/session — le serveur revalide
 *      TOUT et fige la commande ;
 *   2. Payment Element (cartes, Apple Pay, Google Pay, 3DS automatique)
 *      sur le client_secret retourné. Modifier l'adresse recote la même
 *      commande (même intent, montant ajusté).
 */
export function CheckoutFlow({
  locale,
  labels,
  publishableKey,
  cartPath,
  successPath,
}: CheckoutFlowProps) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [phase, setPhase] = useState<'loading' | 'form' | 'payment' | 'empty'>('loading');
  const [form, setForm] = useState<AddressFormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

  const stripePromise = useMemo<Promise<Stripe | null> | null>(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  );

  const reloadCart = useCallback(async () => {
    try {
      const next = await fetchCart();
      setCart(next);
      setPhase(next.items.length === 0 ? 'empty' : 'form');
    } catch {
      setPhase('empty');
    }
  }, []);

  useEffect(() => {
    void reloadCart();
  }, [reloadCart]);

  const set = (field: keyof AddressFormState) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submitAddress = async () => {
    const errors = validate(form, labels);
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) return;

    setSubmitting(true);
    setBanner(null);
    setCouponError(null);
    const address: CheckoutAddressInput = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      company: form.company.trim() || undefined,
      line1: form.line1.trim(),
      line2: form.line2.trim() || undefined,
      city: form.city.trim(),
      province: form.province,
      postalCode: form.postalCode.trim(),
      country: form.country,
      phone: form.phone.trim() || undefined,
    };
    try {
      const next = await createCheckoutSession({
        email: form.email.trim(),
        locale,
        shippingAddress: address,
        couponCode: form.couponCode.trim() || undefined,
        customerNote: form.customerNote.trim() || undefined,
      });
      setSession(next);
      setPhase('payment');
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === 'CART_CHANGED') {
          setBanner(labels.cartChanged);
          await reloadCart();
        } else if (cause.code && cause.code in labels.couponErrors) {
          setCouponError(labels.couponErrors[cause.code]!);
        } else if (cause.code === 'CART_EMPTY') {
          setPhase('empty');
        } else if (cause.code === 'INVALID_ADDRESS') {
          const issues = Array.isArray(cause.body.issues)
            ? (cause.body.issues as Array<{ path: string; message: string }>)
            : [];
          const next: FieldErrors = {};
          for (const issue of issues) {
            if (issue.path === 'postalCode') {
              next.postalCode =
                form.country === 'CA' ? labels.invalidPostalCode : labels.invalidZip;
            } else if (issue.path in form) {
              next[issue.path as keyof AddressFormState] = labels.requiredField;
            }
          }
          setFieldErrors(next);
        } else if (cause.status === 503) {
          setBanner(labels.paymentUnavailable);
        } else {
          setBanner(labels.genericError);
        }
      } else {
        setBanner(labels.genericError);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!publishableKey || !stripePromise) {
    return (
      <div className="empty-state">
        <p>{labels.paymentNotConfigured}</p>
        <a className="btn" href={cartPath}>
          {labels.backToCart}
        </a>
      </div>
    );
  }

  if (phase === 'loading') {
    return <p className="muted">{labels.preparing}</p>;
  }

  if (phase === 'empty') {
    return (
      <div className="empty-state">
        <p>{labels.cartEmpty}</p>
        <a className="btn" href={cartPath}>
          {labels.backToCart}
        </a>
      </div>
    );
  }

  const regionCodes = form.country === 'CA' ? PROVINCE_CODES : US_STATE_CODES;
  const field = (
    name: keyof AddressFormState,
    label: string,
    props: Partial<{ type: string; autoComplete: string; required: boolean }> = {},
  ) => (
    <div className="field">
      <label htmlFor={`chk-${name}`}>{label}</label>
      <input
        id={`chk-${name}`}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        value={form[name]}
        onChange={(event) => set(name)(event.target.value)}
        aria-invalid={Boolean(fieldErrors[name])}
      />
      {fieldErrors[name] && <p className="field-error">{fieldErrors[name]}</p>}
    </div>
  );

  return (
    <div className="checkout-layout">
      <div className="checkout-main">
        {banner && (
          <div className="notice" role="alert">
            {banner}
          </div>
        )}

        {phase === 'form' && (
          <form
            className="checkout-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAddress();
            }}
          >
            <h2>{labels.contact}</h2>
            {field('email', labels.email, { type: 'email', autoComplete: 'email' })}
            <p className="muted small">{labels.emailHelp}</p>

            <h2>{labels.shippingAddress}</h2>
            <div className="field-pair">
              {field('firstName', labels.firstName, { autoComplete: 'given-name' })}
              {field('lastName', labels.lastName, { autoComplete: 'family-name' })}
            </div>
            {field('company', labels.company, { autoComplete: 'organization' })}
            {field('line1', labels.line1, { autoComplete: 'address-line1' })}
            {field('line2', labels.line2, { autoComplete: 'address-line2' })}
            <div className="field-pair">
              {field('city', labels.city, { autoComplete: 'address-level2' })}
              <div className="field">
                <label htmlFor="chk-country">{labels.country}</label>
                <select
                  id="chk-country"
                  autoComplete="country"
                  value={form.country}
                  onChange={(event) => {
                    const country = event.target.value as 'CA' | 'US';
                    setForm((current) => ({
                      ...current,
                      country,
                      province: country === 'CA' ? 'QC' : 'NY',
                    }));
                  }}
                >
                  <option value="CA">{labels.countryCA}</option>
                  <option value="US">{labels.countryUS}</option>
                </select>
              </div>
            </div>
            <div className="field-pair">
              <div className="field">
                <label htmlFor="chk-province">
                  {form.country === 'CA' ? labels.province : labels.state}
                </label>
                <select
                  id="chk-province"
                  autoComplete="address-level1"
                  value={form.province}
                  onChange={(event) => set('province')(event.target.value)}
                >
                  {regionCodes.map((code) => (
                    <option key={code} value={code}>
                      {form.country === 'CA'
                        ? PROVINCES[code as (typeof PROVINCE_CODES)[number]].name[locale]
                        : code}
                    </option>
                  ))}
                </select>
              </div>
              {field('postalCode', form.country === 'CA' ? labels.postalCode : labels.zipCode, {
                autoComplete: 'postal-code',
              })}
            </div>
            {field('phone', labels.phone, { type: 'tel', autoComplete: 'tel' })}

            <div className="field">
              <label htmlFor="chk-coupon">{labels.coupon}</label>
              <input
                id="chk-coupon"
                type="text"
                placeholder={labels.couponPlaceholder}
                value={form.couponCode}
                onChange={(event) => {
                  set('couponCode')(event.target.value);
                  setCouponError(null);
                }}
                aria-invalid={Boolean(couponError)}
              />
              {couponError && <p className="field-error">{couponError}</p>}
            </div>
            <div className="field">
              <label htmlFor="chk-note">{labels.note}</label>
              <textarea
                id="chk-note"
                rows={2}
                value={form.customerNote}
                onChange={(event) => set('customerNote')(event.target.value)}
              />
            </div>

            <button type="submit" className="btn cart-checkout-btn" disabled={submitting}>
              {submitting ? labels.preparing : labels.continueToPayment}
            </button>
            <a className="cart-continue" href={cartPath}>
              {labels.backToCart}
            </a>
          </form>
        )}

        {phase === 'payment' && session && (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret: session.clientSecret,
              locale,
              appearance: {
                variables: {
                  colorPrimary: '#185d34',
                  borderRadius: '6px',
                  fontFamily: 'inherit',
                },
              },
            }}
          >
            <PaymentForm
              session={session}
              labels={labels}
              locale={locale}
              successPath={successPath}
              onEdit={() => {
                setSession(null);
                setPhase('form');
              }}
            />
          </Elements>
        )}
      </div>

      {phase === 'payment' && session ? (
        <OrderPanel order={session.order} labels={labels} locale={locale} />
      ) : (
        cart && (
          <aside className="card checkout-summary">
            <h2>{labels.summary}</h2>
            <ul className="summary-lines">
              {cart.items.map((line) => (
                <li key={line.variantId}>
                  <span>
                    {line.quantity} × {locale === 'fr' ? line.nameFr : line.nameEn}
                  </span>
                  <span>{formatMoney(line.lineSubtotalCents, line.currency, locale)}</span>
                </li>
              ))}
            </ul>
            <SummaryRow label={labels.subtotal} cents={cart.subtotalCents} locale={locale} strong />
          </aside>
        )
      )}
    </div>
  );
}
