"""Check real archived source geometry, including explicit independent NC pins."""
from pathlib import Path
import copy
import gzip
import json

namespace = {}
script = Path('scripts/pspice-full-drawing-learning.py').read_text(encoding='utf8')
exec(compile(script.split('mode=sys.argv[1]')[0], 'pspice-study-geometry', 'exec'), namespace)
audit = namespace['audit_csv_geometry']
base = Path('docs/artifacts/drawing-learning-full-20261004')
eligible = {'PS001','PS003','PS005','PS006','PS008','PS009','PS010','PS011','PS012','PS013','PS014','PS015','PS016','PS017','PS018','PS019','PS020','PS021','PS022','PS023','PS024','PS025'}
results = []
oscillator = None
amplifier = None
impedance = None
converter = None
motor_feedback = None
motor_rotor = None
motor_stator = None
archived_controller = None
pwm_driver = None
pwm_controller = None
working_controller = None
nonlinear_load = None
for path in sorted(base.glob('P*/evidence.json.gz')):
    evidence = json.loads(gzip.decompress(path.read_bytes()))
    for case in evidence['cases']:
        if case['id'] in eligible:
            results.append({'id': case['id'], **audit(case)})
        if case['id'] == 'PS013':
            oscillator = case
        if case['id'] == 'PS014':
            amplifier = case
        if case['id'] == 'PS015':
            impedance = case
        if case['id'] == 'PS016':
            converter = case
        if case['id'] == 'PS017':
            motor_feedback = case
        if case['id'] == 'PS018':
            motor_rotor = case
        if case['id'] == 'PS019':
            motor_stator = case
        if case['id'] == 'PS020':
            archived_controller = case
        if case['id'] == 'PS021':
            pwm_driver = case
        if case['id'] == 'PS022':
            pwm_controller = case
        if case['id'] == 'PS024':
            working_controller = case
        if case['id'] == 'PS025':
            nonlinear_load = case
assert {row['id'] for row in results} == eligible
assert oscillator is not None
assert amplifier is not None
assert impedance is not None
assert converter is not None
assert motor_feedback is not None
assert motor_rotor is not None
assert motor_stator is not None
assert archived_controller is not None
assert pwm_driver is not None
assert pwm_controller is not None
assert working_controller is not None
assert nonlinear_load is not None
failures = []
for name, line in [
    ('short_independent_NC_pins', 'WIRE 1550 1150 1550 950'),
    ('short_NC_to_output', 'WIRE 1550 1150 1550 1050'),
    ('join_original_undotted_crossing', 'DOT 2200 1050'),
]:
    damaged = copy.deepcopy(oscillator)
    damaged['originalLines'].append(line)
    try:
        audit(damaged)
    except AssertionError as error:
        failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
    else:
        raise AssertionError(f'Failed to detect {name}')
for name, line in [
    ('bypass_input_coupling_capacitor', 'WIRE 600 1700 750 1700'),
    ('bypass_output_coupling_capacitor', 'WIRE 1600 1900 1750 1900'),
    ('short_hierarchical_impedance_ports', 'WIRE 900 1650 900 1300'),
]:
    damaged = copy.deepcopy(amplifier)
    damaged['originalLines'].append(line)
    try:
        audit(damaged)
    except AssertionError as error:
        failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
    else:
        raise AssertionError(f'Failed to detect {name}')
for name, line in [
    ('short_child_ZX_output_ports', 'WIRE 1200 2050 1200 1950'),
    ('bypass_child_offset_resistor', 'WIRE 1300 1850 1300 1650'),
    ('bypass_child_reference_resistor', 'WIRE 1000 1800 1000 1600'),
]:
    damaged = copy.deepcopy(impedance)
    damaged['originalLines'].append(line)
    try:
        audit(damaged)
    except AssertionError as error:
        failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
    else:
        raise AssertionError(f'Failed to detect {name}')
for name, line in [
    ('bypass_converter_output_inductor', 'WIRE 1600 2450 1900 2450'),
    ('short_converter_RC_series_midpoint', 'WIRE 1400 2300 1400 2450'),
    ('short_mirrored_ZX_output_ports', 'WIRE 2200 2350 2200 2250'),
]:
    damaged = copy.deepcopy(converter)
    damaged['originalLines'].append(line)
    try:
        audit(damaged)
    except AssertionError as error:
        failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
    else:
        raise AssertionError(f'Failed to detect {name}')
for name, line in [
    ('bypass_motor_feedback_capacitor', 'WIRE 1100 2400 1250 2400'),
    ('short_motor_comparator_inputs', 'WIRE 800 1700 800 1900'),
    ('short_motor_comparator_supplies', 'WIRE 1000 1650 1000 1950'),
]:
    damaged = copy.deepcopy(motor_feedback)
    damaged['originalLines'].append(line)
    try:
        audit(damaged)
    except AssertionError as error:
        failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
    else:
        raise AssertionError(f'Failed to detect {name}')
for case, mutations in [
    (motor_rotor, [('bypass_rotor_inductor', 'WIRE 1250 2050 1550 2050'),
                   ('short_motor_control_to_output', 'WIRE 500 1900 700 1900')]),
    (motor_stator, [('bypass_stator_resistor', 'WIRE 700 2300 900 2300'),
                    ('bypass_stator_inductor', 'WIRE 1100 2300 1400 2300')]),
    (archived_controller, [('short_uA741_independent_offset_NC', 'WIRE 1150 1800 1150 1600'),
                          ('short_uA741_NC_to_output', 'WIRE 1150 1800 1150 1700'),
                          ('bypass_uA741_feedback_capacitor', 'WIRE 950 2450 1100 2450'),
                          ('bypass_uA741_stage_input_resistor', 'WIRE 1600 1800 1800 1800')]),
    (pwm_driver, [('bypass_pwm_input_resistor', 'WIRE 2200 1800 2400 1800'),
                  ('short_pwm_MOS_gate_to_source', 'WIRE 3850 1800 4000 1700'),
                  ('bypass_pwm_flyback_diode', 'WIRE 4300 1750 4300 1900'),
                  ('bypass_pwm_motor_inductor', 'WIRE 5150 2250 5450 2250'),
                  ('short_pwm_opto_A_to_K', 'WIRE 3200 2100 3200 2000')]),
    (pwm_controller, [('short_pwm_controller_offset_NC', 'WIRE 1100 2000 1100 1800'),
                      ('short_pwm_controller_NC_to_output', 'WIRE 1100 2000 1100 1900'),
                      ('bypass_pwm_controller_feedback_capacitor', 'WIRE 1000 2300 1150 2300'),
                      ('bypass_pwm_controller_stage_resistor', 'WIRE 1650 1900 1850 1900'),
                      ('short_pwm_controller_supplies', 'WIRE 900 1750 900 2050')]),
    (working_controller, [('short_working_controller_offset_NC', 'WIRE 1650 1850 1650 1650'),
                          ('short_working_controller_NC_to_output', 'WIRE 1650 1850 1650 1750'),
                          ('bypass_working_controller_feedback_capacitor', 'WIRE 1550 2150 1700 2150'),
                          ('bypass_working_controller_stage_resistor', 'WIRE 2200 1750 2400 1750'),
                          ('short_working_controller_supplies', 'WIRE 1450 1600 1450 1900')]),
    (nonlinear_load, [('bypass_nonlinear_load_input_capacitor', 'WIRE 200 1950 350 1950'),
                      ('bypass_nonlinear_load_output_capacitor', 'WIRE 1150 2050 1300 2050'),
                      ('short_nonlinear_load_ZX_output_ports', 'WIRE 2550 2050 2550 1950'),
                      ('bypass_nonlinear_load_reference_resistor', 'WIRE 2350 1600 2350 1800'),
                      ('bypass_nonlinear_load_offset_resistor', 'WIRE 2800 1600 2800 1800'),
                      ('bypass_nonlinear_load_offset_voltage', 'WIRE 1950 1800 1950 1600')]),
]:
    for name, line in mutations:
        damaged = copy.deepcopy(case)
        damaged['originalLines'].append(line)
        try:
            audit(damaged)
        except AssertionError as error:
            failures.append({'mutation': name, 'rejected': True, 'reason': str(error)})
        else:
            raise AssertionError(f'Failed to detect {name}')
# Exercise the real archived $PN-last block: changing its quoted package
# number cannot change connectivity, while changing its trailing net must.
changed_package = copy.deepcopy(archived_controller)
lines = changed_package['connectivity']['lines']
lines[lines.index('$PN"3"16;')] = '$PN"30"16;'
assert audit(changed_package) == audit(archived_controller)
changed_net = copy.deepcopy(archived_controller)
lines = changed_net['connectivity']['lines']
lines[lines.index('$PN"3"16;')] = '$PN"3"17;'
try:
    audit(changed_net)
except AssertionError:
    failures.append({'mutation': 'change_uA741_trailing_net_keep_package_pin', 'rejected': True})
else:
    raise AssertionError('Package pin metadata was mistaken for the CSV net.')
# Keep the driver's original $PN/FLOAT/Clock ordering in this check.
changed_package = copy.deepcopy(pwm_driver)
lines = changed_package['connectivity']['lines']
pin = next(i for i,line in enumerate(lines) if line == '"+"' and '$PN"3"' in lines[i+1:i+4])
package = next(i for i in range(pin+1,pin+4) if lines[i].startswith('$PN"3"'))
lines[package] = lines[package].replace('$PN"3"', '$PN"30"')
assert audit(changed_package) == audit(pwm_driver)
assert pwm_driver['namedNetEquivalence']['ROTOR_IN']['csvLocalNets'] == [11,21]
assert set(pwm_driver['decorativePins']) == {'I34','I35'}
assert not (set(pwm_driver['verifiedPins']) & set(pwm_driver['decorativePins']))
# The real PS025 source includes historical bias-current values in pin blocks.
# Changing that value must not affect connectivity; its trailing net must.
changed_bias = copy.deepcopy(nonlinear_load)
lines = changed_bias['connectivity']['lines']
lines[lines.index('$BIASCURRENT"3.927uA"')] = '$BIASCURRENT"99.0uA"'
assert audit(changed_bias) == audit(nonlinear_load)
changed_net = copy.deepcopy(nonlinear_load)
lines = changed_net['connectivity']['lines']
pin = lines.index('"b"')
assert lines[pin+2] == 'Clock"False"1;'
lines[pin+2] = 'Clock"False"14;'
try:
    audit(changed_net)
except AssertionError:
    failures.append({'mutation': 'change_BJT_net_keep_archived_biascurrent', 'rejected': True})
else:
    raise AssertionError('Archived bias current was mistaken for the CSV net.')
report = {'originalCasesPassed': results, 'invalidMutationsRejected': failures,
          'quotedPackageNumberDoesNotChangeNet': True,
          'archivedBiasCurrentDoesNotChangeNet': True,
          'scope': 'Archived source geometry only; no product or simulation acceptance.'}
(base/'P023/geometry-regression.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
print(json.dumps({'realCases':len(results),'mutationsRejected':len(failures)}))
