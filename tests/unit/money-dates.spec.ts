import { describe, expect, it } from 'vitest';
import {
  addDaysYmd, businessDateString, currentMonthRange, endExclusiveOfBusinessDay, parseSheetDate, previousPeriod, startOfBusinessDay,
} from '../../src/shared/utils/dates';
import { applyBps, centsToReais, parseMoneyToCents } from '../../src/shared/utils/money';

describe('parseMoneyToCents', () => {
  it.each([
    ['R$ 1.234,56', 123456],
    ['1234.56', 123456],
    ['1.234', 123400], // padrão de milhar BR
    ['0,5', 50],
    ['12,5', 1250],
    ['297', 29700],
    ['-45,90', -4590],
    ['(45,90)', -4590],
    ['0', 0],
    ['0,00', 0],
    ['1.234.567,89', 123456789],
  ])('%s -> %d', (raw, cents) => {
    expect(parseMoneyToCents(raw)).toBe(cents);
  });

  it('diferencia vazio de zero', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('   ')).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents('0')).toBe(0);
  });

  it('rejeita lixo em vez de inventar valor', () => {
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('12,3x')).toBeNull();
  });

  it('não sofre erro de ponto flutuante (19,90 e 0,29)', () => {
    expect(parseMoneyToCents('19,90')).toBe(1990);
    expect(parseMoneyToCents('0,29')).toBe(29);
    expect(parseMoneyToCents('1.005,05')).toBe(100505);
  });

  it('formata centavos e aplica pontos-base', () => {
    expect(centsToReais(123456)).toBe('1234.56');
    expect(centsToReais(-5)).toBe('-0.05');
    expect(applyBps(100000, 250)).toBe(2500); // 2,5%
  });
});

describe('datas no fuso America/Sao_Paulo', () => {
  it('interpreta dd/mm/yyyy HH:mm:ss como horário de São Paulo (UTC-3)', () => {
    expect(parseSheetDate('15/10/2026 10:30:00')?.toISOString()).toBe('2026-10-15T13:30:00.000Z');
  });

  it('meia-noite: 23:59 de SP ainda é o mesmo dia mesmo já sendo o dia seguinte em UTC', () => {
    const d = parseSheetDate('15/10/2026 23:59:59')!;
    expect(d.toISOString()).toBe('2026-10-16T02:59:59.000Z');
    expect(businessDateString(d)).toBe('2026-10-15');
    expect(businessDateString(parseSheetDate('16/10/2026 00:00:00')!)).toBe('2026-10-16');
  });

  it('respeita offset explícito e rejeita datas inválidas', () => {
    expect(parseSheetDate('2026-10-15T10:00:00Z')?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    expect(parseSheetDate('31/02/2026')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('ontem')).toBeNull();
  });

  it('limites de período são [meia-noite SP, meia-noite SP do dia seguinte)', () => {
    expect(startOfBusinessDay('2026-10-01').toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(endExclusiveOfBusinessDay('2026-10-19').toISOString()).toBe('2026-10-20T03:00:00.000Z');
  });

  it('período anterior tem a mesma duração e termina no dia anterior', () => {
    expect(previousPeriod('2026-10-10', '2026-10-19')).toEqual({ de: '2026-09-30', ate: '2026-10-09' });
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('mês atual no fuso de negócio (01/11 02:00 UTC ainda é 31/10 em SP)', () => {
    expect(currentMonthRange(new Date('2026-11-01T02:00:00Z'))).toEqual({ de: '2026-10-01', ate: '2026-10-31' });
  });
});
